import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { readQuestions } from '../lint/lint';
import { RULES } from '../lint/rules';
import { ask, type Fetch, isFailure } from './client';
import { toLiteral } from './literal';
import {
	buildRequest,
	buildRequestReview,
	REVIEWS,
	readAnswers,
	readRequestAnswers,
} from './reviews';

const ALL = new Set(REVIEWS.map((review) => review.code));
const MODEL = 'jev-1.13.0';

function literalOf(text: string) {
	const question = readQuestions(text).questions[0];
	return question ? toLiteral(question) : undefined;
}

describe('a question as data', () => {
	it('is the question exactly as written', () => {
		expect(
			literalOf(
				`const r = { questions: { q: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: null } } } };`,
			),
		).toEqual({
			type: 'choice',
			instructions: 'Which?',
			criteria: { a: 'A', b: null },
		});
	});

	it.each([
		['instructions', `{ type: 'noul', instructions: build() }`],
		[
			'one option',
			`{ type: 'choice', instructions: 'Which?', criteria: { a: label, b: 'B' } }`,
		],
		[
			'a spread',
			`{ type: 'choice', instructions: 'Which?', criteria: { ...rest, b: 'B' } }`,
		],
	])('is withheld when %s is built at runtime', (_name, source) => {
		expect(
			literalOf(`const r = { questions: { q: ${source} } };`),
		).toBeUndefined();
	});
});

describe('what is put to Jev', () => {
	it('sends the question as state and one yes/no check per defect', () => {
		const request = buildRequest(
			{ type: 'noul', instructions: 'Is it large?' },
			MODEL,
			ALL,
		);
		expect(request?.state).toEqual({
			question: { type: 'noul', instructions: 'Is it large?' },
		});
		expect(request?.model).toBe(MODEL);
		expect(Object.keys(request?.questions ?? {})).toEqual(['JEV301', 'JEV302']);
	});

	// Ids with a dot are the per-entry locating questions.
	const main = (
		question: Parameters<typeof buildRequest>[0],
		context?: Parameters<typeof buildRequest>[3],
	) =>
		Object.keys(
			buildRequest(question, MODEL, ALL, context)?.questions ?? {},
		).filter((key) => !key.includes('.'));

	it('asks only the checks that fit the question type', () => {
		expect(main({ type: 'noul', instructions: 'Is it?' })).toEqual([
			'JEV301',
			'JEV302',
		]);
		expect(
			main({
				type: 'choice',
				instructions: 'Which?',
				criteria: { a: 'A', b: 'B', c: 'C' },
			}),
		).toEqual(['JEV301', 'JEV303', 'JEV305', 'JEV306', 'JEV307']);
		expect(
			main({ type: 'score', instructions: 'Rate', criteria: ['x', 'y'] }),
		).toEqual(['JEV301', 'JEV304', 'JEV306', 'JEV308']);
	});

	it('asks about other questions only when there are some, and names them', () => {
		const alone = buildRequest(
			{ type: 'noul', instructions: 'Is it?' },
			MODEL,
			ALL,
		);
		expect(alone?.state).toEqual({
			question: { type: 'noul', instructions: 'Is it?' },
		});
		const beside = buildRequest(
			{ type: 'noul', instructions: 'Is it?' },
			MODEL,
			ALL,
			{
				siblings: ['topic', 'mood'],
			},
		);
		expect(beside?.state.other_questions).toEqual(['topic', 'mood']);
		expect(Object.keys(beside?.questions ?? {})).toContain('JEV309');
	});

	it('sends the state only when it is given one', () => {
		const without = buildRequest(
			{ type: 'noul', instructions: 'Is it?' },
			MODEL,
			ALL,
			{ siblings: [] },
		);
		expect('state' in (without?.state ?? {})).toBe(false);
		const withState = buildRequest(
			{ type: 'noul', instructions: 'Is it?' },
			MODEL,
			ALL,
			{
				siblings: [],
				state: { note: 'n' },
			},
		);
		expect(withState?.state.state).toEqual({ note: 'n' });
		expect(Object.keys(withState?.questions ?? {})).toContain('JEV311');
	});

	it('sends nothing when every check that fits is switched off', () => {
		expect(
			buildRequest({ type: 'noul', instructions: 'Is it?' }, MODEL, new Set()),
		).toBeUndefined();
	});

	it('reports a check only at or above its cutoff', () => {
		const cutoff =
			REVIEWS.find((review) => review.code === 'JEV302')?.cutoff ?? 0;
		expect(readAnswers({ JEV302: { noul: cutoff - 0.01 } })).toEqual([]);
		expect(
			readAnswers({ JEV302: { noul: cutoff } }).map((f) => f.code),
		).toEqual(['JEV302']);
		expect(readAnswers({})).toEqual([]);
	});

	it('asks about each option in the same request, to find the ones at fault', () => {
		const request = buildRequest(
			{
				type: 'choice',
				instructions: 'Which?',
				criteria: { pet: 'An animal kept at home', dog: 'A dog' },
			},
			MODEL,
			new Set(['JEV303']),
		);
		expect(Object.keys(request?.questions ?? {})).toEqual([
			'JEV303',
			'JEV303.0',
			'JEV303.1',
		]);
		expect(JSON.stringify(request?.questions['JEV303.1'])).toContain(
			'\\"dog\\"',
		);
	});

	it('names the two entries Jev rates highest, and none when it rates none', () => {
		const pointed = readAnswers({
			JEV303: { noul: 0.9 },
			'JEV303.0': { noul: 0.2 },
			'JEV303.1': { noul: 0.7 },
			'JEV303.2': { noul: 0.6 },
		});
		expect(pointed[0]?.culprits).toEqual([1, 2]);
		const vague = readAnswers({
			JEV303: { noul: 0.9 },
			'JEV303.0': { noul: 0.3 },
			'JEV303.1': { noul: 0.2 },
		});
		expect(vague[0]?.culprits).toEqual([]);
	});

	it('does not ask about each entry of a very long list', () => {
		const criteria = Object.fromEntries(
			Array.from({ length: 13 }, (_, i) => [`o${i}`, null]),
		);
		const request = buildRequest(
			{ type: 'choice', instructions: 'Which?', criteria },
			MODEL,
			new Set(['JEV303']),
		);
		expect(Object.keys(request?.questions ?? {})).toEqual(['JEV303']);
	});

	it('asks one request about every pair of questions, and about the state if given', () => {
		const questions = {
			a: { type: 'noul' as const, instructions: 'One?' },
			b: { type: 'noul' as const, instructions: 'Two?' },
			c: { type: 'noul' as const, instructions: 'Three?' },
		};
		const pairs = buildRequestReview(
			questions,
			MODEL,
			new Set(['JEV310', 'JEV312']),
		);
		expect(Object.keys(pairs?.questions ?? {})).toEqual([
			'JEV310.0.1',
			'JEV310.0.2',
			'JEV310.1.2',
		]);
		expect('state' in (pairs?.state ?? {})).toBe(false);
		const withState = buildRequestReview(
			questions,
			MODEL,
			new Set(['JEV310', 'JEV312']),
			'text',
		);
		expect(Object.keys(withState?.questions ?? {})).toContain('JEV312');
		expect(
			buildRequestReview(
				{ a: questions.a },
				MODEL,
				new Set(['JEV310', 'JEV312']),
			),
		).toBeUndefined();
	});

	it('reads a pair above the cutoff back to its two question ids', () => {
		const found = readRequestAnswers(['a', 'b', 'c'], {
			'JEV310.0.1': { noul: 0.02 },
			'JEV310.1.2': { noul: 0.6 },
			JEV312: { noul: 0.99 },
		});
		expect(found).toEqual([
			{ code: 'JEV310', first: 'b', second: 'c', probability: 0.6 },
			{ code: 'JEV312', probability: 0.99 },
		]);
	});

	it('has a registered rule behind every check', () => {
		for (const review of REVIEWS)
			expect(RULES[review.code].code).toBe(review.code);
	});
});

// The probabilities Jev returned for every corpus question, saved by
// scripts/calibrate-reviews.ts. Reading them costs nothing, so the cutoffs are
// held to them here: a check may not flag a question the corpus calls good.
describe('cutoffs against the saved calibration', () => {
	const saved: { probabilities: Record<string, Record<string, number>> } =
		JSON.parse(
			readFileSync(
				new URL('../../fixtures/validation/calibration.json', import.meta.url),
				'utf8',
			),
		);
	const corpus: { id: string; defects: string[] }[] = JSON.parse(
		readFileSync(
			new URL('../../fixtures/corpus/questions.json', import.meta.url),
			'utf8',
		),
	);
	const LABEL: Record<string, string> = {
		JEV301: 'JEV102',
		JEV302: 'JEV112',
		JEV303: 'JEV303',
		JEV304: 'JEV304',
	};

	it.each(REVIEWS)(
		'$code flags no good corpus question and catches most bad ones',
		(review) => {
			const at = (id: string) => saved.probabilities[id]?.[review.code];
			const flagged = (ids: string[]) =>
				ids.filter((id) => (at(id) ?? 0) >= review.cutoff);
			const good = corpus
				.filter((entry) => !entry.defects.length)
				.map((entry) => entry.id);
			const bad = corpus
				.filter((entry) =>
					entry.defects.includes(LABEL[review.code] ?? review.code),
				)
				.map((entry) => entry.id);
			expect(flagged(good)).toEqual([]);
			expect(flagged(bad).length).toBeGreaterThanOrEqual(
				Math.ceil(bad.length * 0.6),
			);
		},
	);
});

describe('the client', () => {
	const request = buildRequest(
		{ type: 'noul', instructions: 'Is it?' },
		MODEL,
		ALL,
	);
	if (!request) throw new Error('no request');
	const reply = (status: number, body: unknown = {}) => ({
		ok: status === 200,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	});
	const deps = (fetch: Fetch) => ({
		fetch,
		key: 'secret-key',
		wait: vi.fn(async () => {}),
	});

	it('sends the key as a bearer token and reads the reply', async () => {
		const fetch = vi.fn(async () =>
			reply(200, {
				model: MODEL,
				answers: { JEV302: { noul: 0.9 } },
				usage: { input_tokens: 300 },
			}),
		);
		const result = await ask(deps(fetch), request);
		expect(result).toEqual({
			model: MODEL,
			answers: { JEV302: { noul: 0.9 } },
			inputTokens: 300,
		});
		const init = (
			fetch.mock.calls[0] as unknown as [
				string,
				{ headers: Record<string, string>; body: string },
			]
		)[1];
		expect(init.headers.Authorization).toBe('Bearer secret-key');
		expect(JSON.parse(init.body).state.question.instructions).toBe('Is it?');
	});

	it('does not retry a bad key', async () => {
		const fetch = vi.fn(async () => reply(401));
		const result = await ask(deps(fetch), request);
		expect(isFailure(result) && result.kind).toBe('key');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('retries a busy service three times and then stops', async () => {
		const fetch = vi.fn(async () => reply(429));
		const d = deps(fetch);
		const result = await ask(d, request);
		expect(isFailure(result) && result.kind).toBe('busy');
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(d.wait).toHaveBeenCalledTimes(2);
	});

	it('recovers when the service stops being busy', async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(reply(529))
			.mockResolvedValueOnce(
				reply(200, { model: MODEL, answers: {}, usage: {} }),
			);
		expect(isFailure(await ask(deps(fetch), request))).toBe(false);
	});

	it('reports a network error without the key in it', async () => {
		const fetch = vi.fn(async () => {
			throw new Error('getaddrinfo ENOTFOUND');
		});
		const result = await ask(deps(fetch), request);
		expect(result).toEqual({
			kind: 'network',
			detail: 'getaddrinfo ENOTFOUND',
		});
		expect(JSON.stringify(result)).not.toContain('secret-key');
	});
});
