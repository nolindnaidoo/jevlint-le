/**
 * Finds the cutoff for each check Jev makes.
 *
 * Every corpus question and request is sent with the checks that apply to it,
 * and the probability each returned is saved. A cutoff is then read off the
 * saved numbers, so choosing or changing one costs nothing after the first
 * run. Only checks with no saved number are sent, so adding a check costs one
 * pass over the entries it applies to and not a rerun of everything.
 *
 * A development tool: it costs money, needs a key, and no test runs it.
 *
 *   bun scripts/calibrate-reviews.ts --dry-run
 *   doppler run -- bun scripts/calibrate-reviews.ts
 *   bun scripts/calibrate-reviews.ts --report     read calibration.json, no calls
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ask, type Fetch, isFailure } from '../src/jev/client';
import type { QuestionLiteral } from '../src/jev/literal';
import {
	buildRequest,
	buildRequestReview,
	REQUEST_REVIEWS,
	REVIEWS,
	type ReviewRequest,
} from '../src/jev/reviews';

type Entry = { id: string; defects: string[]; question: QuestionLiteral; siblings?: string[] };
type RequestEntry = {
	id: string;
	state?: unknown;
	questions: Record<string, QuestionLiteral>;
	overlapping: [string, string][];
	missing?: string[];
	injected?: boolean;
};
type Saved = {
	ranOn: string;
	model: string;
	calls: number;
	inputTokens: number;
	probabilities: Record<string, Record<string, number>>;
};
type Job = { id: string; request: ReviewRequest };
type Reading = { id: string; p: number };

// The wording defect each check is the meaning-reading version of. Others are labeled by their own code.
const LABEL: Record<string, string> = { JEV301: 'JEV102', JEV302: 'JEV112' };
const MODEL = 'jev-1.13.0';
const MAX_CALLS = 400;

const load = <T>(name: string): T =>
	JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const corpus = load<Entry[]>('corpus/questions.json');
const requests = load<RequestEntry[]>('corpus/requests.json');
const out = new URL('../fixtures/validation/calibration.json', import.meta.url);
const saved: Saved = existsSync(out)
	? JSON.parse(readFileSync(out, 'utf8'))
	: { ranOn: '', model: '', calls: 0, inputTokens: 0, probabilities: {} };

// The checks an entry still needs: every code with no saved number for it.
const missing = (id: string, codes: string[]) =>
	new Set(codes.filter((code) => saved.probabilities[id]?.[code] === undefined));

function jobs(): Job[] {
	const perQuestion = REVIEWS.map((review) => review.code);
	const list: Job[] = [];
	const add = (id: string, request: ReviewRequest | undefined) => {
		if (request) list.push({ id, request });
	};
	for (const entry of corpus) {
		add(
			entry.id,
			buildRequest(entry.question, MODEL, missing(entry.id, perQuestion), {
				siblings: entry.siblings ?? [],
			}),
		);
	}
	for (const entry of requests) {
		const ids = Object.keys(entry.questions);
		const pairDone = Object.keys(saved.probabilities[entry.id] ?? {}).length > 0;
		if (!pairDone) {
			add(entry.id, buildRequestReview(entry.questions, MODEL, new Set(['JEV310', 'JEV312']), entry.state));
		}
		if (entry.state === undefined) continue;
		for (const id of ids) {
			const key = `${entry.id}/${id}`;
			add(
				key,
				buildRequest(entry.questions[id] as QuestionLiteral, MODEL, missing(key, ['JEV311']), {
					siblings: [],
					state: entry.state,
				}),
			);
		}
	}
	return list;
}

async function collect(key: string, list: Job[]): Promise<void> {
	let calls = 0;
	for (const job of list) {
		if (calls >= MAX_CALLS) throw new Error(`stopped at ${MAX_CALLS} calls`);
		calls += 1;
		const reply = await ask(
			{ fetch: fetch as unknown as Fetch, key, wait: (ms) => new Promise((r) => setTimeout(r, ms)) },
			job.request,
		);
		if (isFailure(reply)) throw new Error(`${job.id}: ${reply.kind} ${reply.detail}`);
		saved.model = reply.model;
		saved.inputTokens += reply.inputTokens;
		saved.probabilities[job.id] = {
			...saved.probabilities[job.id],
			...Object.fromEntries(Object.entries(reply.answers).map(([code, answer]) => [code, answer.noul ?? 0])),
		};
	}
	saved.calls += calls;
	saved.ranOn = new Date().toISOString().slice(0, 10);
	writeFileSync(out, `${JSON.stringify(saved, null, 1)}\n`);
	console.log(`${calls} calls this run, ${saved.calls} in all, answered by ${saved.model}.`);
}

function show(code: string, bad: Reading[], good: Reading[]): void {
	const by = (list: Reading[]) => [...list].sort((a, b) => a.p - b.p);
	const top = by(good).slice(-1)[0]?.p ?? 0;
	const floor = Math.min(0.99, Math.ceil((top + 0.005) * 100) / 100);
	console.log(`\n${code}  bad ${bad.length}  good ${good.length}`);
	console.log(`  bad:      ${by(bad).map((x) => x.p.toFixed(2)).join(' ')}`);
	console.log(`  top good: ${by(good).slice(-5).map((x) => `${x.p.toFixed(2)} ${x.id}`).join(' | ')}`);
	console.log(`  lowest cutoff flagging no good one: ${floor.toFixed(2)} -> catches ${bad.filter((x) => x.p >= floor).length} of ${bad.length}`);
}

function report(): void {
	const at = (id: string, code: string) => saved.probabilities[id]?.[code];
	const read = (ids: string[], code: string): Reading[] =>
		ids.flatMap((id) => {
			const p = at(id, code);
			return p === undefined ? [] : [{ id, p }];
		});
	for (const review of REVIEWS.filter((r) => r.code !== 'JEV311')) {
		const label = LABEL[review.code] ?? review.code;
		show(
			review.code,
			read(corpus.filter((e) => e.defects.includes(label)).map((e) => e.id), review.code),
			read(corpus.filter((e) => !e.defects.length).map((e) => e.id), review.code),
		);
	}
	const pairs = requests.flatMap((entry) => {
		const ids = Object.keys(entry.questions);
		return Object.entries(saved.probabilities[entry.id] ?? {}).flatMap(([code, p]) => {
			const match = /^JEV310\.(\d+)\.(\d+)$/.exec(code);
			if (!match) return [];
			const a = ids[Number(match[1])] as string;
			const b = ids[Number(match[2])] as string;
			const bad = entry.overlapping.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
			return [{ id: `${entry.id}:${a}+${b}`, p, bad }];
		});
	});
	show('JEV310', pairs.filter((x) => x.bad), pairs.filter((x) => !x.bad));
	const stated = requests.filter((entry) => entry.state !== undefined);
	const perQuestion = stated.flatMap((entry) =>
		Object.keys(entry.questions).flatMap((id) => {
			const p = at(`${entry.id}/${id}`, 'JEV311');
			return p === undefined ? [] : [{ id: `${entry.id}/${id}`, p, bad: (entry.missing ?? []).includes(id) }];
		}),
	);
	show('JEV311', perQuestion.filter((x) => x.bad), perQuestion.filter((x) => !x.bad));
	const orders = stated.flatMap((entry) => {
		const p = at(entry.id, 'JEV312');
		return p === undefined ? [] : [{ id: entry.id, p, bad: Boolean(entry.injected) }];
	});
	show('JEV312', orders.filter((x) => x.bad), orders.filter((x) => !x.bad));
	console.log(`\ncutoffs in code: ${[...REVIEWS.map((r) => `${r.code} ${r.cutoff}`), `JEV310 ${REQUEST_REVIEWS.JEV310.cutoff}`, `JEV312 ${REQUEST_REVIEWS.JEV312.cutoff}`].join(', ')}`);
}

async function main(): Promise<void> {
	if (process.argv.includes('--report')) return report();
	const list = jobs();
	if (process.argv.includes('--dry-run')) {
		console.log(`Dry run: ${list.length} calls would be made. Nothing was sent.`);
		return;
	}
	const key = process.env.TYPESAFE_API_KEY;
	if (!key) {
		console.error('TYPESAFE_API_KEY is not set. Run under `doppler run --`, or pass --dry-run.');
		process.exit(1);
	}
	await collect(key, list);
	report();
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
