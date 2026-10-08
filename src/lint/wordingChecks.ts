import type { Finding, Node, Question, RuleCode, StringNode } from '../types';
import { type Check, NONE, PLACEHOLDER, report } from './finding';
import {
	ABSENCE,
	ARITHMETIC,
	COMPARISON_SYMBOL,
	DATE_COMPARISON,
	DEGREE_WORDS,
	GENERATION_VERB,
	HAND_OVER,
	INTENSIFIERS,
	JOINED_CLAUSE,
	LEADS_NEGATIVE,
	NEGATING_VERB,
	NEGATIVE_WORD,
	NEGATOR,
	NUMERIC_ENCODING,
	OPEN_QUESTION,
	PHRASE_OPENER,
	STACKED_NEGATION,
	VAGUE_PREDICATE,
} from './lexicon';

/**
 * The sentence a wording rule reads. Structured instructions keep the
 * question in a field named `question`, which is the vendor's own convention.
 */
function questionText(question: Question): StringNode | undefined {
	const instructions = question.instructions;
	if (instructions?.kind === 'string') return instructions;
	if (instructions?.kind !== 'object') return undefined;
	const field = instructions.props.find((prop) => prop.key === 'question');
	return field?.value.kind === 'string' ? field.value : undefined;
}

// Text in backticks or double quotes is a field name or quoted data, not the
// question's own wording. A quoted sentence full of 'and' and 'before' says
// nothing about how the question was asked.
function prose(text: string): string {
	return text.replace(/`[^`]*`|"[^"]*"|\u201c[^\u201d]*\u201d/g, ' ');
}

function sentences(text: string): ReadonlyArray<string> {
	return text.split(/[.?!]+\s+/);
}

// A long instruction often sets the scene before it asks. Only the asking
// sentences can join two judgments, so context is left out when there is one.
// Statement-form instructions put the claim first and the guidance after.
function asked(text: string): string {
	const questions = text.match(/[^.?!]*\?/g);
	return questions ? questions.join(' ') : (sentences(text)[0] ?? text);
}

/** Wording rules read English. Text in another script is left alone. */
export function isEnglish(text: string): boolean {
	const letters = text.match(/\p{L}/gu)?.length ?? 0;
	const latin = text.match(/[a-z]/gi)?.length ?? 0;
	return letters > 0 && latin / letters >= 0.9;
}

function count(text: string, pattern: RegExp): number {
	return text.match(pattern)?.length ?? 0;
}

function negations(sentence: string): number {
	// "whether or not" asks one question and negates nothing.
	const plain = sentence.replace(/\bor not\b/gi, ' ');
	const explicit = count(plain, NEGATOR);
	if (!explicit) return 0;
	return explicit + count(plain, NEGATIVE_WORD) + count(plain, NEGATING_VERB);
}

// Two negations only fight when they share a clause. "With no tools, no
// documentation and no access" negates three things once each.
function clauses(sentence: string): ReadonlyArray<string> {
	return sentence.split(/[,;:()\u2014\u2013]|\b(?:and|or|but)\b/i);
}

function negatesTwice(text: string): boolean {
	if (sentences(text).some((sentence) => STACKED_NEGATION.test(sentence))) {
		return true;
	}
	// Outside a question, "do not infer facts not stated" is a clear order and
	// not a puzzle, so only questions are read clause by clause.
	const questions = text.match(/[^.?!]*\?/g) ?? [];
	return questions.some((sentence) =>
		clauses(sentence).some((clause) => negations(clause) >= 2),
	);
}

// Two judgments, as against two nouns. "muddy and closed" after "Is the trail"
// is two; "about billing and shipping" is one topic with two words in it.
function joinsJudgments(sentence: string): boolean {
	if (JOINED_CLAUSE.test(sentence)) return true;
	if (!/^\s*(?:is|are|was|were)\b/i.test(sentence)) return false;
	const joined = /^(.*?)\band (\w+)/i.exec(sentence);
	if (!joined || PHRASE_OPENER.test(joined[1] ?? '')) return false;
	return /(?:ed|ing)$/i.test(joined[2] ?? '');
}

// "What the screen shows disagrees with the state" is a statement that opens
// with What. Only a sentence that ends in a question mark asks it.
function opensOrHandsOver(text: string): boolean {
	if (HAND_OVER.test(text)) return true;
	return text.includes('?') && OPEN_QUESTION.test(asked(text));
}

function isNegative(text: string): boolean {
	return LEADS_NEGATIVE.test(text) || ABSENCE.test(text);
}

function wording(
	code: RuleCode,
	message: string,
	test: (text: string, question: Question) => boolean,
): Check {
	return (question) => {
		const text = questionText(question);
		if (!text || PLACEHOLDER.test(text.value) || !isEnglish(text.value))
			return NONE;
		if (!test(prose(text.value), question)) return NONE;
		return [report(code, question, message, text.span)];
	};
}

const checkDoubleNegative = wording(
	'JEV101',
	'This question negates twice. Jev answers doubly negated questions less reliably. Ask for the positive case directly.',
	negatesTwice,
);

const checkArithmetic = wording(
	'JEV102',
	'This question asks Jev to count or compare numbers, which it does not do reliably. Ask one question per item and do the arithmetic in code.',
	(text) =>
		COMPARISON_SYMBOL.test(text) ||
		ARITHMETIC.some((pattern) => pattern.test(asked(text))),
);

const checkDateComparison = wording(
	'JEV103',
	'This question asks Jev to order or measure dates, which it reads as text and not as quantities. Have it extract the parts of each date and compare them in code.',
	(text) => DATE_COMPARISON.some((pattern) => pattern.test(asked(text))),
);

const checkCompound = wording(
	'JEV104',
	"This question joins two judgments with 'and'. An input that is one and not the other cannot be answered. Ask each as its own question and combine the answers in code.",
	(text, question) =>
		question.type === 'noul' && sentences(asked(text)).some(joinsJudgments),
);

const checkGeneration = wording(
	'JEV105',
	'This asks for a value or for text. Jev only picks among answers you give it. Offer the candidates as a Choice, or use a generative model.',
	(text, question) =>
		GENERATION_VERB.test(text) ||
		(question.type === 'noul' && opensOrHandsOver(text)),
);

const checkNegatedNoul = wording(
	'JEV107',
	'This yes/no question is phrased so that yes means something is absent. Jev reads that less reliably. Ask whether the thing is present and invert the answer in code.',
	// With criteria the author has said what a yes means, which is the cure.
	(text, question) =>
		question.type === 'noul' && !question.criteria && ABSENCE.test(asked(text)),
);

const checkUndefinedBoundary = wording(
	'JEV112',
	"This question turns on a word with no stated line, so Jev reads it at face value and may draw the line elsewhere. Say where yes ends and no begins in the instructions or in 'true' and 'false' criteria.",
	// A slot may be where the line is stated, so a question with one is left alone.
	(text, question) =>
		question.type === 'noul' &&
		!question.criteria &&
		!questionText(question)?.slots &&
		VAGUE_PREDICATE.test(asked(text)),
);

const checkNumericEncoding = wording(
	'JEV111',
	'This question refers to a value by its hex or RGB encoding. Jev judges named values better than encoded ones. Convert it in code and pass the name.',
	(text) => NUMERIC_ENCODING.test(text),
);

function criterion(question: Question, key: string): string | undefined {
	const criteria = question.criteria;
	if (criteria?.kind !== 'object') return undefined;
	const value = criteria.props.find((prop) => prop.key === key)?.value;
	return value?.kind === 'string' ? value.value : undefined;
}

const checkInvertedCriteria: Check = (question) => {
	if (question.type !== 'noul') return NONE;
	const text = questionText(question);
	const yes = criterion(question, 'true');
	const no = criterion(question, 'false');
	if (!text || yes === undefined || no === undefined) return NONE;
	// A negatively worded question legitimately has a negative 'true'.
	if (negations(text.value) || isNegative(text.value)) return NONE;
	if (!isNegative(yes) || isNegative(no)) return NONE;
	return [
		report(
			'JEV108',
			question,
			"The 'true' criterion describes the negative case and 'false' the positive, against a question asked in the positive. Align the criteria with the question.",
			question.criteriaKey,
		),
	];
};

function levelTexts(question: Question): ReadonlyArray<StringNode> {
	if (question.type !== 'score' || question.criteria?.kind !== 'array')
		return [];
	if (question.criteria.partial) return [];
	return question.criteria.items.filter(
		(item: Node): item is StringNode => item.kind === 'string',
	);
}

function words(level: string): ReadonlyArray<string> {
	return level.toLowerCase().match(/[a-z]+/g) ?? [];
}

// "Very casual / slang": the label is before the slash, the rest is a gloss on it.
function label(level: string): string {
	return level.split(/\s*\/\s*/)[0] ?? level;
}

function isDegree(level: string): boolean {
	const all = words(level);
	return (
		all.length > 0 &&
		all.every((word) => DEGREE_WORDS.has(word) || INTENSIFIERS.has(word))
	);
}

const ARTICLES: ReadonlySet<string> = new Set(['a', 'an', 'the']);

// "Shallow", "Like new", "Almost none": a word or two that names a rung and
// describes nothing. A level with a participle in it ("Not started", "Parts
// fitted") says what happened, however short, and is left alone.
function isBareLabel(level: string): boolean {
	const content = words(level).filter(
		(word) => !INTENSIFIERS.has(word) && !ARTICLES.has(word),
	);
	if (!content.length || content.length > 2) return false;
	return !content.some((word) => /(?:ed|ing)$/.test(word)) && !/\d/.test(level);
}

// "Not noisy", "Noisy", "Extremely noisy": one word, turned up and down. So is
// "Weak fit", "Good fit", "Exceptional fit", even beside one level that
// describes something, which is why three sharing a word is enough.
function isLadder(levels: ReadonlyArray<string>): boolean {
	const heads = levels.map((level) =>
		words(level)
			.filter((word) => !INTENSIFIERS.has(word) && !DEGREE_WORDS.has(word))
			.join(' '),
	);
	const named = heads.filter(Boolean);
	if (new Set(named).size === 1) return named.length > 0;
	return named.some(
		(head) => named.filter((other) => other === head).length >= 3,
	);
}

const checkDegreeLevels: Check = (question): ReadonlyArray<Finding> => {
	const levels = levelTexts(question);
	if (levels.length < 2 || question.criteria?.kind !== 'array') return NONE;
	if (levels.length !== question.criteria.items.length) return NONE;
	const texts = levels.map((level) => label(level.value));
	if (!texts.every(isEnglish)) return NONE;
	if (!texts.every(isDegree) && !isLadder(texts) && !texts.every(isBareLabel))
		return NONE;
	return [
		report(
			'JEV110',
			question,
			'These Score levels name degrees, not situations. Jev matches the state against each description, so describe what each level looks like.',
			question.criteria.span,
		),
	];
};

/** The rules that read how a question is worded. Heuristics, scored against the corpus. */
export const WORDING_CHECKS: ReadonlyArray<Check> = Object.freeze([
	checkDoubleNegative,
	checkArithmetic,
	checkDateComparison,
	checkCompound,
	checkGeneration,
	checkNegatedNoul,
	checkInvertedCriteria,
	checkDegreeLevels,
	checkNumericEncoding,
	checkUndefinedBoundary,
]);
