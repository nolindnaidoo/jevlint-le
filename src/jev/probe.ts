import type { QuestionLiteral } from './literal';
import type { ReviewRequest } from './reviews';

type Answer = Readonly<{
	noul?: number;
	choice?: string;
	score?: number;
	confidence?: number;
	probabilities?: Readonly<Record<string, number>>;
}>;

/** One answer, reduced to the decision a program would act on and the number behind it. */
export type Reading = Readonly<{ decision: string; number: number }>;

export type Variant = Readonly<{
	name: string;
	/** What was changed, in words a reader of the report needs. */
	change: string;
	request: ReviewRequest;
	read: (answer: Answer) => Reading;
}>;

export type ProbeResult = Readonly<{ variant: Variant; reading: Reading }>;

const ID = 'q';
const REPEATS = 3;

const READERS: Readonly<
	Record<QuestionLiteral['type'], (answer: Answer) => Reading>
> = Object.freeze({
	noul: (answer: Answer) => ({
		decision: (answer.noul ?? 0) > 0.5 ? 'yes' : 'no',
		number: answer.noul ?? 0,
	}),
	choice: (answer: Answer) => ({
		decision: answer.choice ?? '',
		number: answer.confidence ?? 0,
	}),
	score: (answer: Answer) => ({
		decision: String(Math.round(answer.score ?? 0)),
		number: answer.score ?? 0,
	}),
});

const NUMBER_NAMES: Readonly<Record<QuestionLiteral['type'], string>> =
	Object.freeze({
		noul: 'probability of yes',
		choice: 'confidence',
		score: 'score',
	});

function variant(
	name: string,
	change: string,
	state: unknown,
	model: string,
	question: QuestionLiteral,
	read: (answer: Answer) => Reading = READERS[question.type],
): Variant {
	return {
		name,
		change,
		request: {
			state: state as ReviewRequest['state'],
			model,
			questions: { [ID]: question },
		},
		read,
	};
}

function optionsOf(
	question: QuestionLiteral,
): ReadonlyArray<[string, unknown]> {
	const criteria = question.criteria;
	if (question.type !== 'choice' || !criteria || Array.isArray(criteria))
		return [];
	return Object.entries(criteria);
}

// The same options in the opposite order. Jev leans toward the first option.
function reversedOptions(
	state: unknown,
	model: string,
	question: QuestionLiteral,
): Variant[] {
	const options = optionsOf(question);
	if (options.length < 2) return [];
	const criteria = Object.fromEntries([...options].reverse());
	return [
		variant(
			'options reversed',
			'The same options, listed in the opposite order.',
			state,
			model,
			{ ...question, criteria },
		),
	];
}

// The same descriptions under blank names, to see how much the names alone decided.
function hiddenLabels(
	state: unknown,
	model: string,
	question: QuestionLiteral,
): Variant[] {
	const options = optionsOf(question);
	const described = options.every(
		([, description]) => typeof description === 'string' && description.trim(),
	);
	if (options.length < 2 || !described) return [];
	const criteria = Object.fromEntries(
		options.map(([, description], i) => [`option_${i + 1}`, description]),
	);
	const back = (answer: Answer): Reading => {
		const position = Number((answer.choice ?? '').replace('option_', '')) - 1;
		return {
			decision: options[position]?.[0] ?? answer.choice ?? '',
			number: answer.confidence ?? 0,
		};
	};
	return [
		variant(
			'names hidden',
			'The same descriptions, with each option name replaced by a blank one.',
			state,
			model,
			{ ...question, criteria },
			back,
		),
	];
}

// The same levels in the opposite order, read back flipped.
function reversedLevels(
	state: unknown,
	model: string,
	question: QuestionLiteral,
): Variant[] {
	const levels = question.criteria;
	if (question.type !== 'score' || !Array.isArray(levels) || levels.length < 2)
		return [];
	const top = levels.length - 1;
	const flipped = (answer: Answer): Reading => {
		const score = top - (answer.score ?? 0);
		return { decision: String(Math.round(score)), number: score };
	};
	return [
		variant(
			'levels reversed',
			'The same levels, listed in the opposite order and read back flipped.',
			state,
			model,
			{ ...question, criteria: [...levels].reverse() },
			flipped,
		),
	];
}

// The instructions alone, to see how much the criteria are doing.
function withoutCriteria(
	state: unknown,
	model: string,
	question: QuestionLiteral,
): Variant[] {
	if (question.type !== 'noul' || question.criteria === undefined) return [];
	return [
		variant(
			'criteria removed',
			'The instructions alone, with the criteria taken away.',
			state,
			model,
			{ type: 'noul', instructions: question.instructions },
		),
	];
}

/**
 * The requests that test whether an answer depends on how the question is
 * laid out. Every change is mechanical. Nothing rewrites the wording, because
 * a reworded question changes the meaning along with the layout, and then a
 * moved answer cannot be blamed on either.
 */
export function buildProbe(
	state: unknown,
	question: QuestionLiteral,
	model: string,
): ReadonlyArray<Variant> {
	const repeats = Array.from({ length: REPEATS }, (_, i) =>
		variant(
			`as written ${i + 1}`,
			'The question exactly as written.',
			state,
			model,
			question,
		),
	);
	return [
		...repeats,
		...reversedOptions(state, model, question),
		...hiddenLabels(state, model, question),
		...reversedLevels(state, model, question),
		...withoutCriteria(state, model, question),
	];
}

export function readProbe(
	variant: Variant,
	answers: Readonly<Record<string, Answer>>,
): Reading {
	return variant.read(answers[ID] ?? {});
}

/** The report, as Markdown, and whether any variant changed the decision. */
export function summarize(
	id: string,
	type: QuestionLiteral['type'],
	results: ReadonlyArray<ProbeResult>,
): Readonly<{
	markdown: string;
	/** The one sentence the report opens with. */
	verdict: string;
	moved: ReadonlyArray<string>;
}> {
	const baseline = results[0]?.reading;
	const repeats = results.slice(0, REPEATS).map((result) => result.reading);
	const changes = results.slice(REPEATS);
	const numbers = repeats.map((reading) => reading.number);
	const spread = Math.max(...numbers) - Math.min(...numbers);
	const unsteady = repeats.some(
		(reading) => reading.decision !== baseline?.decision,
	);
	const moved = changes
		.filter((result) => result.reading.decision !== baseline?.decision)
		.map((result) => result.variant.name);

	const verdict = unsteady
		? 'The answer changed between identical requests. It is too close to call, and no layout is to blame.'
		: moved.length
			? `The answer changed when the question was laid out differently: ${moved.join(', ')}.`
			: changes.length
				? 'The answer held under every change.'
				: 'There was nothing to vary for this question, so only repeats were run.';

	const rows = results.map(
		(result) =>
			`| ${result.variant.name} | ${result.reading.decision} | ${result.reading.number.toFixed(2)} | ${result.reading.decision === baseline?.decision ? '' : 'changed'} |`,
	);
	const notes = changes.map(
		(result) => `- **${result.variant.name}**: ${result.variant.change}`,
	);
	const markdown = [
		`# Probe of \`${id}\``,
		'',
		verdict,
		'',
		`Across ${REPEATS} identical requests the ${NUMBER_NAMES[type]} moved by ${spread.toFixed(2)}. A change smaller than that is noise.`,
		'',
		`| Variant | Answer | ${NUMBER_NAMES[type]} | |`,
		'|---|---|---|---|',
		...rows,
		'',
		...(notes.length ? ['## What each variant changed', '', ...notes, ''] : []),
		'Each row is one request, sent with the state written in the file. A held answer shows the layout did not decide it. It does not show the answer is right.',
		'',
	].join('\n');
	return {
		markdown,
		verdict,
		moved: unsteady ? ['identical requests'] : moved,
	};
}
