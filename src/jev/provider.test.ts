import { describe, expect, it } from 'vitest';
import { ask, type Fetch, isFailure } from './client';
import { forProvider, isCalibrated, providerFor } from './provider';
import { buildRequest } from './reviews';

const ALL = new Set([
	'JEV301',
	'JEV302',
	'JEV303',
	'JEV304',
	'JEV305',
	'JEV306',
	'JEV307',
	'JEV308',
]);
const question = {
	type: 'choice' as const,
	instructions: 'Which team should handle this?',
	criteria: { billing: 'Charges', technical: 'Faults' },
};

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(reply: unknown, sent: Sent[]): Fetch {
	return async (url, init) => {
		sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
		return {
			ok: true,
			status: 200,
			json: async () => reply,
			text: async () => '',
		};
	};
}

describe('which vendor a model belongs to', () => {
	it.each([
		['jev-1.13.0', 'typesafe'],
		['jev-latest', 'typesafe'],
		['gpt-6-luna', 'openai'],
		['gpt-6-luna-2026-10-06', 'openai'],
	])('%s is %s', (model, id) => {
		expect(providerFor(model).id).toBe(id);
	});

	it('counts only Jev as calibrated, since the cutoffs were set there', () => {
		expect(isCalibrated('jev-1.13.0')).toBe(true);
		expect(isCalibrated('gpt-6-luna')).toBe(false);
	});

	it('rewords a message for the model that answered', () => {
		expect(
			forProvider('Jev reads this as counting.', providerFor('gpt-6-luna')),
		).toBe('Luna reads this as counting.');
		expect(
			forProvider('Jev reads this as counting.', providerFor('jev-1.13.0')),
		).toBe('Jev reads this as counting.');
	});
});

describe("a review sent to OpenAI's Decisions API", () => {
	const request = buildRequest(question, 'gpt-6-luna', ALL);
	if (!request) throw new Error('no request');

	it('goes to the Decisions endpoint as predicates, with the question as text input', async () => {
		const sent: Sent[] = [];
		const reply = {
			answers: [{ type: 'predicate', name: 'JEV303', probability: 0.8 }],
			usage: { input_tokens: 321 },
		};
		const result = await ask(
			{ fetch: fakeFetch(reply, sent), key: 'sk-test', wait: async () => {} },
			request,
		);
		expect(sent[0]?.url).toBe('https://api.openai.com/v1/decisions');
		expect(sent[0]?.headers.Authorization).toBe('Bearer sk-test');
		const body = sent[0]?.body as {
			model: string;
			input: string;
			questions: { type: string; name: string; instructions: string }[];
		};
		expect(body.model).toBe('gpt-6-luna');
		expect(JSON.parse(body.input)).toEqual({ question });
		expect(body.questions.every((q) => q.type === 'predicate')).toBe(true);
		// Jev's criteria become part of the instructions, since a predicate has no criteria field.
		const overlap = body.questions.find((q) => q.name === 'JEV303');
		expect(overlap?.instructions).toContain(
			'Answer yes when: Two of the options cover some of the same cases.',
		);
		expect(overlap?.instructions).toContain('Answer no when:');
		// A locating question's dot travels as underscores and comes back.
		expect(body.questions.some((q) => q.name === 'JEV303__0')).toBe(true);
		if (isFailure(result)) throw new Error(result.detail);
		expect(result).toEqual({
			model: 'gpt-6-luna',
			inputTokens: 321,
			answers: { JEV303: { noul: 0.8 } },
		});
	});

	it('maps a locating answer back to its dotted id, and drops a refusal', async () => {
		const reply = {
			model: 'gpt-6-luna',
			answers: [
				{ type: 'predicate', name: 'JEV303', probability: 0.9 },
				{ type: 'predicate', name: 'JEV303__1', probability: 0.7 },
				{ type: 'refusal', name: 'JEV301' },
			],
		};
		const result = await ask(
			{ fetch: fakeFetch(reply, []), key: 'k', wait: async () => {} },
			request,
		);
		if (isFailure(result)) throw new Error(result.detail);
		expect(result.answers).toEqual({
			JEV303: { noul: 0.9 },
			'JEV303.1': { noul: 0.7 },
		});
	});

	it('calls a reply with no answers list garbled, naming Luna', async () => {
		const result = await ask(
			{ fetch: fakeFetch({ choices: [] }, []), key: 'k', wait: async () => {} },
			request,
		);
		expect(result).toEqual({
			kind: 'garbled',
			detail: 'the answer was not a Luna reply',
		});
	});

	it('still sends a Jev request to TypeSafe unchanged', async () => {
		const sent: Sent[] = [];
		const jev = buildRequest(question, 'jev-1.13.0', ALL);
		if (!jev) throw new Error('no request');
		await ask(
			{
				fetch: fakeFetch({ answers: {} }, sent),
				key: 'k',
				wait: async () => {},
			},
			jev,
		);
		expect(sent[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
		expect(sent[0]?.body).toEqual(jev);
	});
});
