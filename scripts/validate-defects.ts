/**
 * Asks Jev whether the defects the rules report actually cost answers.
 *
 * Each experiment in fixtures/validation/experiments.json holds one badly
 * written question, the same question written well, and a handful of states
 * whose right answer is known. Both are sent for every state, and the script
 * reports how often each was right. A rule whose bad arm does as well as its
 * good arm is reporting a defect that does not exist for this model version.
 *
 * This is a development tool. The extension never calls Jev, and no test runs
 * this: it costs money and needs a key.
 *
 *   bun scripts/validate-defects.ts --dry-run      what would be sent, no key
 *   doppler run -- bun scripts/validate-defects.ts needs TYPESAFE_API_KEY
 *
 * Results go to fixtures/validation/results.json with the model version that
 * answered, because a result is only true of that version.
 */
import { readFileSync, writeFileSync } from 'node:fs';

type Question = Record<string, unknown>;
type Arm = {
	questions?: Record<string, Question>;
	/** One question per entry of a state array, for the count-in-code pattern. */
	each?: { over: string; id: string; question: Question };
	decide: string;
	/** Answers that count as right for an expected value, where the arm's options differ from the fixed arm's. */
	accept?: Record<string, Array<string | number>>;
};
type Case = { state: unknown; expected: boolean | string | number };
type Experiment = {
	rule: string;
	name: string;
	cases: Case[];
	bad: Arm;
	good: Arm | null;
};
type Answer = {
	noul?: number;
	choice?: string;
	score?: number;
	probabilities?: Record<string, number>;
	confidence?: number;
};
type Tally = { right: number; asked: number; sure: number[] };

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Pinned, because a result under an alias would silently change meaning.
const MODEL = 'jev-1.13.0';
const MAX_CALLS = 250;
const RETRIES = 3;
const YES = 0.5;

const root = new URL('../fixtures/validation/', import.meta.url);
// `--set hard` runs fixtures/validation/hard.json and writes results-hard.json.
const setFlag = process.argv.indexOf('--set');
const set = setFlag === -1 ? 'experiments' : (process.argv[setFlag + 1] ?? '');
const experiments: Experiment[] = JSON.parse(
	readFileSync(new URL(`${set}.json`, root), 'utf8'),
);
const dryRun = process.argv.includes('--dry-run');
const key = process.env.TYPESAFE_API_KEY;

function questionsFor(arm: Arm, state: unknown): Record<string, Question> {
	if (arm.questions) return arm.questions;
	if (!arm.each) throw new Error('an arm needs `questions` or `each`');
	const items = (state as Record<string, unknown[]>)[arm.each.over] ?? [];
	const { id, question } = arm.each;
	return Object.fromEntries(
		items.map((_, i) => [
			`${id}${i}`,
			{
				...question,
				instructions: String(question.instructions).replace('{i}', String(i)),
			},
		]),
	);
}

const yes = (answer: Answer | undefined) => (answer?.noul ?? 0) > YES;

// How an arm turns answers into the one value compared with `expected`.
const DECIDERS: Record<
	string,
	(
		args: string[],
		answers: Record<string, Answer>,
		state: unknown,
	) => boolean | string | number
> = {
	noul: ([id], answers) => yes(answers[id ?? '']),
	not: ([id], answers) => !yes(answers[id ?? '']),
	and: (ids, answers) => ids.every((id) => yes(answers[id])),
	choice: ([id], answers) => answers[id ?? '']?.choice ?? '',
	choice_conf: ([id], answers) => answers[id ?? '']?.choice ?? '',
	score_conf: ([id], answers) => Math.round(answers[id ?? '']?.score ?? -1),
	score: ([id], answers) => Math.round(answers[id ?? '']?.score ?? -1),
	count_gt: ([prefix, limit], answers) =>
		Object.entries(answers).filter(
			([id, answer]) => id.startsWith(prefix ?? '') && yes(answer),
		).length > Number(limit),
	// The same, with the line to count past taken from a field of the state.
	count_gt_state: ([prefix, field], answers, state) =>
		Object.entries(answers).filter(
			([id, answer]) => id.startsWith(prefix ?? '') && yes(answer),
		).length > Number((state as Record<string, unknown>)[field ?? '']),
};

/**
 * How much weight the answers put on the right outcome, from 0 to 1. Two
 * wordings can both land on the right side of 0.5 while one sits at 0.95 and
 * the other at 0.55, one nudge from flipping. Undefined where an arm combines
 * answers in a way that has no single probability.
 */
function sureness(
	arm: Arm,
	answers: Record<string, Answer>,
	expected: boolean | string | number,
): number | undefined {
	const [kind, ...rest] = arm.decide.split(':');
	const ids = (rest[0] ?? '').split(',');
	const first = answers[ids[0] ?? ''];
	// Jev's own confidence: how peaked the distribution is, whichever answer leads.
	if (kind === 'choice_conf' || kind === 'score_conf') return first?.confidence ?? 0;
	if (kind === 'choice') return first?.probabilities?.[String(expected)] ?? 0;
	if (kind === 'score') {
		const top = Object.keys(first?.probabilities ?? {}).length - 1;
		return 1 - Math.abs((first?.score ?? 0) - Number(expected)) / Math.max(top, 1);
	}
	const yesProbability: Record<string, () => number> = {
		noul: () => first?.noul ?? 0,
		not: () => 1 - (first?.noul ?? 0),
		and: () => Math.min(...ids.map((id) => answers[id]?.noul ?? 0)),
	};
	const p = yesProbability[kind ?? '']?.();
	if (p === undefined) return undefined;
	return expected ? p : 1 - p;
}

function decide(arm: Arm, answers: Record<string, Answer>, state: unknown) {
	const [kind, ...rest] = arm.decide.split(':');
	const decider = DECIDERS[kind ?? ''];
	if (!decider) throw new Error(`unknown decide rule: ${arm.decide}`);
	const args = kind === 'and' ? (rest[0] ?? '').split(',') : rest;
	return decider(args, answers, state);
}

let calls = 0;
let tokens = 0;
let answeredBy = '';

async function ask(
	state: unknown,
	questions: Record<string, Question>,
): Promise<Record<string, Answer>> {
	calls += 1;
	if (calls > MAX_CALLS) throw new Error(`stopped at ${MAX_CALLS} calls`);
	for (let attempt = 1; ; attempt += 1) {
		const response = await fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ state, model: MODEL, questions }),
		});
		if (response.ok) {
			const body = await response.json();
			tokens += body.usage?.input_tokens ?? 0;
			answeredBy = body.model ?? answeredBy;
			return body.answers;
		}
		const busy = response.status === 429 || response.status === 529;
		if (!busy || attempt === RETRIES) {
			throw new Error(`${response.status}: ${await response.text()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
	}
}

async function run(arm: Arm, cases: Case[]): Promise<Tally> {
	const tally: Tally = { right: 0, asked: 0, sure: [] };
	for (const { state, expected } of cases) {
		const questions = questionsFor(arm, state);
		if (dryRun) {
			calls += 1;
			continue;
		}
		tally.asked += 1;
		const answers = await ask(state, questions);
		const decided = decide(arm, answers, state);
		const accepted = arm.accept?.[String(expected)] ?? [expected];
		if (accepted.includes(decided as string | number)) tally.right += 1;
		const sure = sureness(arm, answers, expected);
		if (sure !== undefined) tally.sure.push(sure);
	}
	return tally;
}

const rate = (tally: Tally) =>
	tally.asked ? `${tally.right} of ${tally.asked}` : 'not run';

const mean = (tally: Tally) =>
	tally.sure.length
		? (tally.sure.reduce((a, b) => a + b, 0) / tally.sure.length).toFixed(2)
		: 'n/a';

async function main(): Promise<void> {
	if (!dryRun && !key) {
		console.error(
			'TYPESAFE_API_KEY is not set. Run under `doppler run --`, or pass --dry-run.',
		);
		process.exit(1);
	}
	const results = [];
	for (const experiment of experiments) {
		const bad = await run(experiment.bad, experiment.cases);
		// No good arm means the fix is to do the work in code, which is right by construction.
		const good = experiment.good
			? await run(experiment.good, experiment.cases)
			: undefined;
		results.push({
			rule: experiment.rule,
			name: experiment.name,
			bad: rate(bad),
			badSureness: mean(bad),
			good: good ? rate(good) : 'done in code',
			goodSureness: good ? mean(good) : 'n/a',
		});
		console.log(
			`${experiment.rule}  bad ${rate(bad).padEnd(9)} sure ${mean(bad).padEnd(5)} good ${(good ? rate(good) : 'done in code').padEnd(13)} sure ${(good ? mean(good) : 'n/a').padEnd(5)} ${experiment.name}`,
		);
	}
	if (dryRun) {
		console.log(`\nDry run: ${calls} calls would be made. Nothing was sent.`);
		return;
	}
	const record = {
		ranOn: new Date().toISOString().slice(0, 10),
		model: answeredBy,
		calls,
		inputTokens: tokens,
		results,
	};
	writeFileSync(
		new URL(set === 'experiments' ? 'results.json' : `results-${set}.json`, root),
		`${JSON.stringify(record, null, 2)}\n`,
	);
	console.log(`\n${calls} calls, ${tokens} input tokens, answered by ${answeredBy}.`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
