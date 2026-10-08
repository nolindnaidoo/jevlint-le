import type {
	ArrayNode,
	Node,
	ObjectNode,
	Question,
	StringNode,
} from '../types';
import { type Check, NONE, normalizeOption, repeated, report } from './finding';
import { fallbackFix } from './fix';
import { LIMITS } from './limits';

const NUMERIC = /^\s*-?\d+(\.\d+)?\s*$/;

function choiceOptions(question: Question): ObjectNode | undefined {
	return question.type === 'choice' && question.criteria?.kind === 'object'
		? question.criteria
		: undefined;
}

function scoreLevels(question: Question): ArrayNode | undefined {
	return question.type === 'score' && question.criteria?.kind === 'array'
		? question.criteria
		: undefined;
}

/**
 * `criteria: { "options": [...] }`: the list of options wrapped in a map with
 * one key. The API accepts it as a one-option Choice that answers "options"
 * every time, at confidence 1.0. `JEV006` reports it, so the count rule does not.
 */
export function wrapsList(options: ObjectNode): ArrayNode | undefined {
	if (options.partial || options.props.length !== 1) return undefined;
	const value = options.props[0]?.value;
	return value?.kind === 'array' && value.items.length ? value : undefined;
}

const checkChoiceCount: Check = (question) => {
	const options = choiceOptions(question);
	if (!options || wrapsList(options)) return NONE;
	const count = options.props.length;
	if (count > LIMITS.choiceMaxOptions) {
		return [
			report(
				'JEV002',
				question,
				`This Choice has ${count} options. The API accepts at most ${LIMITS.choiceMaxOptions}.`,
			),
		];
	}
	if (options.partial || count >= 2) return NONE;
	return [
		report(
			'JEV009',
			question,
			`This Choice has ${count} option${count === 1 ? '' : 's'}, so every input gets the same answer.`,
		),
	];
};

const checkFallback: Check = (question, context) => {
	const options = choiceOptions(question);
	if (!options || options.partial || options.props.length < 2) return NONE;
	if (
		options.props.some((entry) =>
			context.fallback.has(normalizeOption(entry.key)),
		)
	)
		return NONE;
	const message =
		"This Choice has no fallback option, so an input that fits none of them is forced into one. Measured: with no fallback, every input that fit no option was answered wrong. Add 'other' or 'insufficient_evidence', or suppress this if the options cover every input.";
	return [
		{
			...report('JEV004', question, message),
			fix: fallbackFix(
				options,
				context.text,
				context.fallbackName,
				context.syntaxAt(options.span.start),
			),
		},
	];
};

const checkDuplicateOptions: Check = (question) => {
	const options = choiceOptions(question);
	if (!options) return NONE;
	return repeated(options.props, (entry) => entry.key).map((entry) =>
		report(
			'JEV005',
			question,
			`Option '${entry.key}' appears twice. The later one silently replaces the earlier.`,
			entry.keySpan,
		),
	);
};

const checkLevelCount: Check = (question) => {
	const levels = scoreLevels(question);
	if (!levels) return NONE;
	const count = levels.items.length;
	if (count > LIMITS.scoreMaxLevels) {
		return [
			report(
				'JEV003',
				question,
				`This Score has ${count} levels. The API accepts at most ${LIMITS.scoreMaxLevels}.`,
			),
		];
	}
	if (levels.partial || count >= LIMITS.scoreMinLevels) return NONE;
	// Not an error: the docs say a Score "should" have two levels, and public
	// code sends one where the levels are generated. It is worth a look in
	// hand-written code, where a one-level scale can only return that level.
	return [
		report(
			'JEV009',
			question,
			`This Score has ${count} level${count === 1 ? '' : 's'}, so every input gets the same answer.`,
		),
	];
};

const checkDuplicateLevels: Check = (question) => {
	const levels = scoreLevels(question);
	if (!levels) return NONE;
	return repeated(levels.items, (item) =>
		item.kind === 'string' ? item.value.trim() : undefined,
	).map((item) =>
		report(
			'JEV005',
			question,
			'This level repeats an earlier one. Two identical levels cannot be told apart.',
			item.span,
		),
	);
};

function isBareNumber(node: Node): boolean {
	if (node.kind === 'number') return true;
	return node.kind === 'string' && NUMERIC.test(node.value);
}

const checkNumericLevels: Check = (question) => {
	const levels = scoreLevels(question);
	if (!levels || levels.partial || levels.items.length < LIMITS.scoreMinLevels)
		return NONE;
	if (!levels.items.every(isBareNumber)) return NONE;
	const message =
		'These Score levels are bare numbers. Jev matches the state against each level description and never sees its position, so a number gives it nothing to match. Describe the situation each level stands for.';
	return [report('JEV008', question, message, levels.span)];
};

// "ready": "Ready", "low": "low", "a": "Option A". Case, underscores, hyphens,
// a closing full stop and the word "option" are spelling, not description.
const sameWords = (key: string, description: string): boolean =>
	normalizeOption(key).replace(/\s+/g, ' ') ===
	normalizeOption(description)
		.replace(/[.!]\s*$/, '')
		.replace(/^(?:option|choice)\s+/, '')
		.replace(/\s+/g, ' ');

/** What people write for a Noul's criteria when they have not described either case. */
const BARE_ANSWERS: ReadonlySet<string> = new Set([
	'yes',
	'no',
	'true',
	'false',
	'y',
	'n',
]);

const checkDescriptionRepeatsName: Check = (question) => {
	const criteria = question.criteria;
	if (criteria?.kind !== 'object' || criteria.partial) return NONE;
	if (question.type === 'choice') {
		return criteria.props
			.filter(
				(entry) =>
					entry.value.kind === 'string' &&
					sameWords(entry.key, entry.value.value),
			)
			.map((entry) =>
				report(
					'JEV011',
					question,
					`The description of '${entry.key}' only repeats its name. Jev matches the state against the description, so say what belongs under this option.`,
					entry.value.span,
				),
			);
	}
	if (question.type === 'noul') {
		return criteria.props
			.filter(
				(entry) =>
					entry.value.kind === 'string' &&
					BARE_ANSWERS.has(
						normalizeOption(entry.value.value).replace(/[.!]\s*$/, ''),
					),
			)
			.map((entry) =>
				report(
					'JEV011',
					question,
					`The '${entry.key}' criterion says '${(entry.value as StringNode).value}', which only repeats the key. Say what makes the answer ${entry.key}, or leave the criteria out.`,
					entry.value.span,
				),
			);
	}
	return NONE;
};

/** The rules that read a Choice's options or a Score's levels. */
export const OPTION_CHECKS: ReadonlyArray<Check> = Object.freeze([
	checkChoiceCount,
	checkFallback,
	checkDuplicateOptions,
	checkLevelCount,
	checkDuplicateLevels,
	checkNumericLevels,
	checkDescriptionRepeatsName,
]);
