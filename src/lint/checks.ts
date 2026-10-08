import type {
	Extraction,
	Finding,
	Malformed,
	Node,
	Question,
	RuleCode,
} from '../types';
import {
	type Check,
	type CheckContext,
	NONE,
	PLACEHOLDER,
	repeated,
	report,
} from './finding';
import {
	choiceMapFix,
	nearestTypeFix,
	pinModelFix,
	renameKeyFix,
	scoreArrayFix,
} from './fix';
import { MODEL_ALIASES, NOUL_CRITERIA_KEYS } from './limits';
import { OPTION_CHECKS, wrapsList } from './optionChecks';
import { isEnglish, WORDING_CHECKS } from './wordingChecks';

// Two words is where the labelled public questions put the line: "how much?",
// "Only tests?" and "Pick one." lean on the id, "Is this toxic?" does not.
const TERSE_WORDS = 2;

const KIND_LABELS: Readonly<Record<Node['kind'], string>> = Object.freeze({
	string: 'a string',
	number: 'a number',
	boolean: 'a boolean',
	null: 'null',
	array: 'an array',
	object: 'a map',
	call: 'a function call',
	unreadable: 'a runtime value',
});

const MALFORMED: Readonly<
	Record<
		Malformed['reason'],
		Readonly<{ code: RuleCode; message: (m: Malformed) => string }>
	>
> = Object.freeze({
	'unknown-type': {
		code: 'JEV007',
		message: (m: Malformed) =>
			`Question type "${m.found}" does not exist. The types are noul, choice and score.`,
	},
	'missing-type': {
		code: 'JEV007',
		message: () =>
			"This question has no 'type'. It must be noul, choice or score.",
	},
	'runtime-type': {
		code: 'JEV000',
		message: () =>
			"Cannot read the 'type' of this question: it is set at runtime, so no rule ran on it.",
	},
	'runtime-question': {
		code: 'JEV000',
		message: () =>
			'Cannot read this question: it is built at runtime, so no rule ran on it.',
	},
});

function isAbsent(node: Node | undefined): boolean {
	return !node || node.kind === 'null';
}

function isHidden(node: Node | undefined): boolean {
	if (!node) return false;
	if (node.kind === 'unreadable') return true;
	return (node.kind === 'object' || node.kind === 'array') && node.partial;
}

const checkUnreadable: Check = (question) => {
	const instructions = question.instructions;
	const slotted =
		instructions?.kind === 'string' && instructions.slots === true;
	const hidden = [
		instructions?.kind === 'unreadable' || slotted ? 'instructions' : '',
		isHidden(question.criteria) ? 'criteria' : '',
	].filter(Boolean);
	if (!hidden.length) return NONE;
	const fields = hidden.join(' and ');
	// With only slots missing, the fixed text around them was still checked.
	const ran =
		slotted && hidden.length === 1
			? 'The fixed text was checked, and the rules that need all of it did not run.'
			: 'The rules that need it did not run.';
	return [
		report(
			'JEV000',
			question,
			`Cannot fully read the ${fields} of this question: part of it is built at runtime. ${ran}`,
		),
	];
};

// A missing `instructions` is not reported. The API reference lists it as
// required, but the SDK types make it optional and send null, and public code
// omits it on Choices whose options carry the meaning.
const checkInstructions: Check = (question) => {
	const instructions = question.instructions;
	if (instructions?.kind !== 'string' || instructions.value.trim()) return NONE;
	// Another client's question object in its blank starting state is not a request.
	if (question.open) return NONE;
	return [
		report(
			'JEV007',
			question,
			'The instructions are empty.',
			instructions.span,
		),
	];
};

function isPlaceholder(node: Node | undefined): boolean {
	return node?.kind === 'string' && PLACEHOLDER.test(node.value);
}

// "How severe?" and "Who answers?" ask something in two words. "Is it?",
// "Pick one." and "how much?" do not, and were the labelled public cases.
const ASKS = /^(?:how|who|what|which|where|when|why)$/i;

const SAID: ReadonlyArray<string> = [
	'have no words in them',
	'are one word',
	'are two words',
];

// "p", "Rate", "Which?": Jev is sent the instructions and never the id, so a
// question whose meaning is in its id asks Jev nothing.
const checkTerseInstructions: Check = (question) => {
	const instructions = question.instructions;
	if (instructions?.kind !== 'string' || question.open) return NONE;
	const text = instructions.value.trim();
	if (!text || PLACEHOLDER.test(text)) return NONE;
	// "?" alone is no words in any language, so it is not left to the English check.
	const count = /\p{L}/u.test(text) ? text.split(/\s+/).length : 0;
	if (count && !isEnglish(text)) return NONE;
	if (count > TERSE_WORDS) return NONE;
	if (count === TERSE_WORDS && ASKS.test(text.split(/\s+/)[0] ?? ''))
		return NONE;
	return [
		report(
			'JEV012',
			question,
			`The instructions ${SAID[count]}, so the question leans on its id for its meaning. Jev reads only the instructions. Write out what is being asked.`,
			instructions.span,
		),
	];
};

// What people write when they mean true and false.
const NOUL_KEY_FIXES: Readonly<Record<string, string>> = Object.freeze({
	yes: 'true',
	y: 'true',
	no: 'false',
	n: 'false',
});

function noulShape(question: Question): ReadonlyArray<Finding> {
	const criteria = question.criteria;
	if (isAbsent(criteria) || criteria?.kind === 'unreadable') return NONE;
	// An empty array or object says "no criteria", which a Noul allows.
	if (criteria?.kind === 'array' && !criteria.items.length) return NONE;
	if (criteria?.kind !== 'object') {
		return [
			report(
				'JEV006',
				question,
				"Noul criteria must be an object with 'true' and 'false' descriptions.",
				question.criteriaKey,
			),
		];
	}
	return criteria.props
		.filter((entry) => !NOUL_CRITERIA_KEYS.has(entry.key))
		.map((entry) => {
			const name = NOUL_KEY_FIXES[entry.key.toLowerCase()];
			return {
				...report(
					'JEV006',
					question,
					`Noul criteria take 'true' and 'false'. '${entry.key}' is not a documented key.`,
					entry.keySpan,
				),
				fix: name ? renameKeyFix(entry, name) : undefined,
			};
		});
}

const SHAPES = Object.freeze({
	choice: { kind: 'object', needs: 'a map of option to description' },
	score: { kind: 'array', needs: 'an ordered array of level descriptions' },
});

function reshapeFix(question: Question, context: CheckContext) {
	const { text } = context;
	const syntax = context.syntaxAt(question.span.start);
	// Turning a list into a map, or back, is spelt differently in every typed language.
	if (syntax !== 'js' && syntax !== 'python') return undefined;
	const criteria = question.criteria;
	if (question.type === 'score' && criteria?.kind === 'object') {
		return scoreArrayFix(text, criteria);
	}
	if (question.type === 'choice' && criteria?.kind === 'array') {
		return choiceMapFix(text, criteria, syntax);
	}
	return undefined;
}

const checkCriteriaShape: Check = (question, context) => {
	// With another client's fields present, `criteria` may not mean what the API means by it.
	if (question.open) return NONE;
	if (isPlaceholder(question.criteria)) return NONE;
	if (question.type === 'noul') return noulShape(question);
	const shape = SHAPES[question.type];
	const criteria = question.criteria;
	if (!criteria || criteria.kind === 'null') {
		if (!question.inRequest) return NONE;
		return [
			report(
				'JEV006',
				question,
				`A ${question.type} question needs 'criteria': ${shape.needs}.`,
			),
		];
	}
	if (criteria.kind === 'unreadable') return NONE;
	if (criteria.kind === shape.kind) {
		if (criteria.kind !== 'object') return NONE;
		const list = wrapsList(criteria);
		if (!list) return NONE;
		const key = criteria.props[0]?.key ?? 'options';
		const syntax = context.syntaxAt(question.span.start);
		return [
			{
				...report(
					'JEV006',
					question,
					`The criteria hold one option, '${key}', whose description is a list. The API accepts that as a one-option Choice, which answers '${key}' every time at full confidence. Make each entry of the list an option.`,
					question.criteriaKey,
				),
				fix:
					syntax === 'js' || syntax === 'python'
						? choiceMapFix(context.text, list, syntax, criteria.span)
						: undefined,
			},
		];
	}
	const found = KIND_LABELS[criteria.kind];
	return [
		{
			...report(
				'JEV006',
				question,
				`The criteria of a ${question.type} question must be ${shape.needs}, not ${found}.`,
				question.criteriaKey,
			),
			fix: reshapeFix(question, context),
		},
	];
};

const QUESTION_CHECKS: ReadonlyArray<Check> = Object.freeze([
	checkUnreadable,
	checkInstructions,
	checkTerseInstructions,
	checkCriteriaShape,
	...OPTION_CHECKS,
	...WORDING_CHECKS,
]);

function checkMalformed(malformed: Malformed, text: string): Finding {
	const kind = MALFORMED[malformed.reason];
	return {
		code: kind.code,
		message: kind.message(malformed),
		span: malformed.anchor,
		questionId: malformed.id,
		fix:
			malformed.reason === 'unknown-type'
				? nearestTypeFix(text, malformed.anchor, malformed.found)
				: undefined,
	};
}

function checkDuplicateIds(extraction: Extraction): ReadonlyArray<Finding> {
	return extraction.maps.flatMap((map) =>
		repeated(map.entries, (entry) => entry.id).map((entry) => ({
			code: 'JEV005' as const,
			message: `Question id '${entry.id}' appears twice. The later one silently replaces the earlier.`,
			span: entry.idSpan,
			questionId: entry.id,
			fix: undefined,
		})),
	);
}

function checkModels(
	extraction: Extraction,
	text: string,
): ReadonlyArray<Finding> {
	return extraction.models
		.filter((model) => MODEL_ALIASES.has(model.value))
		.map((model) => ({
			code: 'JEV001' as const,
			message: `'${model.value}' is an alias that moves to each new release, so answers can change with no change on your side. Pin the versioned id from a response's 'model' field once your thresholds are tuned.`,
			span: model.span,
			questionId: undefined,
			fix: pinModelFix(text, model.span),
		}));
}

/** Runs every rule. Severity, suppression and rule switches are applied by the caller. */
export function check(
	extraction: Extraction,
	context: CheckContext,
): ReadonlyArray<Finding> {
	return [
		...extraction.questions.flatMap((question) =>
			QUESTION_CHECKS.flatMap((run) => run(question, context)),
		),
		...extraction.malformed.map((malformed) =>
			checkMalformed(malformed, context.text),
		),
		...checkDuplicateIds(extraction),
		...checkModels(extraction, context.text),
	];
}
