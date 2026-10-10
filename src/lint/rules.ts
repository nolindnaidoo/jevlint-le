import type { RuleCode, Severity } from '../types';
import { DOCS } from './limits';

export type Rule = Readonly<{
	code: RuleCode;
	name: string;
	/** One sentence on what the rule catches: the README's "What it means" column, and the first line of the rule's page. */
	meaning: string;
	/** `off` for a rule the corpus has not earned a default for. It still runs when a user switches it on. */
	severity: Severity | 'off';
	docs: string;
}>;

/** The single list of rules. SPEC.md and README.md are held to it by `rules.test.ts`, the README's meanings too. */
export const RULES: Readonly<Record<RuleCode, Rule>> = Object.freeze({
	JEV000: {
		code: 'JEV000',
		name: 'unreadable',
		meaning:
			'Part of the question is built at runtime, so the rules that need it did not run',
		severity: 'hint',
		docs: DOCS.api,
	},
	JEV001: {
		code: 'JEV001',
		name: 'unpinned-model',
		meaning:
			'`jev-latest` and `jev-preview` move with each release, so answers can change with no change on your side',
		severity: 'warning',
		docs: DOCS.models,
	},
	JEV002: {
		code: 'JEV002',
		name: 'choice-option-limit',
		meaning: 'A Choice has more than 255 options. The API rejects it',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV003: {
		code: 'JEV003',
		name: 'score-level-limit',
		meaning: 'A Score has more than 10 levels. The API rejects it',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV004: {
		code: 'JEV004',
		name: 'no-fallback-option',
		meaning:
			'A Choice has no `other` or `none of the above`, so an input that fits no option is forced into one. The largest cost measured anywhere, and the hardest to tell from text',
		// The cost is the largest measured anywhere: our run, 4 of 8 right against
		// 8 of 8; an independent KoBBQ audit, 95% abstention with an "unknown"
		// option against 0% accuracy on the same items without one. It still
		// informs, because text cannot show whether the options cover every
		// input: it fires on 9 of the 11 Choice examples TypeSafe publishes as
		// correct and on 65 of the 86 Choices in public sample 3. ESLint's
		// default-case and Biome's useDefaultSwitchClause, the same rule for a
		// switch, are off in both recommended sets for the same reason. The
		// message carries the measurement.
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV005: {
		code: 'JEV005',
		name: 'duplicate',
		meaning:
			'A question id, option or level appears twice. In an object the later one silently replaces the earlier',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV006: {
		code: 'JEV006',
		name: 'criteria-shape',
		meaning:
			'A Choice needs a map of options, a Score needs an array of levels, and a Noul takes `true` and `false`',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV007: {
		code: 'JEV007',
		name: 'invalid-question',
		meaning:
			'The type is missing or unknown, or the instructions are an empty string',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV008: {
		code: 'JEV008',
		name: 'numeric-levels',
		meaning:
			'Score levels are bare numbers. Jev matches the state against each description and never sees its position',
		severity: 'warning',
		docs: DOCS.scoreLevels,
	},
	JEV009: {
		code: 'JEV009',
		name: 'too-few-options',
		meaning:
			'A Choice with one option or a Score with one level gives every input the same answer',
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV010: {
		code: 'JEV010',
		name: 'unused-disable',
		meaning:
			'A `jevlint-le-disable` comment silences nothing, so it can only hide a finding added later',
		severity: 'warning',
		// The one rule about this tool's own comments, so the one with no vendor page.
		docs: 'https://github.com/nolindnaidoo/jevlint-le#suppressing-a-finding',
	},
	JEV011: {
		code: 'JEV011',
		name: 'description-repeats-name',
		meaning:
			"An option's description only repeats its name, or a Noul's criteria say yes and no. Jev matches the state against the description, and this one says nothing",
		// Measured 2026-10-08: "billing": "Billing" answered 12 of 12 either way,
		// and Yes/No criteria 11 of 12 either way, 0.08 less sure. No cost found
		// where the name itself says something. Independent runs found one
		// (smkrv/jev-calibrate, SYED-M-HUSSAIN), and 10 clear cases in public
		// sample 3 were names that say nothing, "a": "A". So it informs.
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV012: {
		code: 'JEV012',
		name: 'terse-instructions',
		meaning:
			'The instructions are one or two words, so the question leans on its id. Jev is sent the instructions and never the id',
		// Measured 2026-10-08: "Refund?" right 9 of 12 at 0.70 sure, against 10 of
		// 12 at 0.85 for the question written out. Advisory by the rule the other
		// wording rules are held to. 23 clear cases in public sample 3, the most
		// common defect there.
		severity: 'info',
		docs: DOCS.primitives,
	},
	JEV101: {
		code: 'JEV101',
		name: 'double-negative',
		meaning:
			'A question negates twice in one clause, or a negation sits directly on another',
		// Measured: right 14 of 15 against 15 of 15, but less sure (0.73 against 0.87).
		severity: 'info',
		docs: `${DOCS.jaggedness}#indirection`,
	},
	JEV102: {
		code: 'JEV102',
		name: 'arithmetic',
		meaning: 'The question asks Jev to count or compare numbers',
		// Measured: counting 20 to 40 items, 8 of 12 at 0.58 sure. Adding three to five
		// numbers against a limit, 5 of 12 at 0.52. No better than a guess.
		severity: 'warning',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV103: {
		code: 'JEV103',
		name: 'date-comparison',
		meaning:
			'The question asks Jev to order two times or measure the gap between them',
		// Measured: ordering two dates, 12 of 12. A window counted in days, 11 of 12 at
		// 0.75 sure, where code is certain. Advisory.
		severity: 'info',
		docs: `${DOCS.jaggedness}#date-and-time-comparison`,
	},
	JEV104: {
		code: 'JEV104',
		name: 'compound',
		meaning: "A Noul joins two judgments with 'and'",
		severity: 'off',
		docs: `${DOCS.primitives}#ask-for-one-snap-judgment-per-question`,
	},
	JEV105: {
		code: 'JEV105',
		name: 'generation',
		meaning: 'The question asks for a value or for text to be written',
		severity: 'warning',
		docs: `${DOCS.jaggedness}#generation`,
	},
	JEV107: {
		code: 'JEV107',
		name: 'negated-noul',
		meaning:
			'A Noul with no criteria is phrased so that yes means something is absent',
		// Measured: 14 of 14 right either way, equally sure. No cost found.
		severity: 'off',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV108: {
		code: 'JEV108',
		name: 'inverted-criteria',
		meaning: "A Noul's 'true' criterion describes the negative case",
		// Measured: 14 of 14 right either way. Jev follows the question and ignores the criteria.
		severity: 'off',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV110: {
		code: 'JEV110',
		name: 'degree-levels',
		meaning:
			'Score levels are degree words, bare labels, or one word turned up and down. Nothing for Jev to match the state against',
		// Measured 2026-10-08: Shallow, Medium, Deep placed 4 of 12 code reviews
		// right, against 12 of 12 for described levels. The largest cost measured
		// on any wording rule here. Also the most common real defect in public
		// code, 15 clear cases across two samples, right on every firing.
		severity: 'warning',
		docs: DOCS.scoreLevels,
	},
	JEV111: {
		code: 'JEV111',
		name: 'numeric-encoding',
		meaning: 'The question refers to a value by hex or RGB encoding',
		// Measured: 12 of 12 right with hex or with names, equally sure. No cost found.
		severity: 'off',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV112: {
		code: 'JEV112',
		name: 'undefined-boundary',
		meaning:
			'A Noul with no criteria turns on a word such as large, often or enough',
		// Measured: 4 of 6 right, against 6 of 6 once criteria drew the line.
		severity: 'info',
		docs: `${DOCS.jaggedness}#literal-reading`,
	},
	JEV301: {
		code: 'JEV301',
		name: 'jev-counting',
		meaning: 'Jev reads the question as needing counting or arithmetic',
		severity: 'warning',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV302: {
		code: 'JEV302',
		name: 'jev-undefined-boundary',
		meaning:
			'Jev reads a Noul as turning on a matter of degree with no stated line',
		severity: 'info',
		docs: `${DOCS.jaggedness}#literal-reading`,
	},
	JEV303: {
		code: 'JEV303',
		name: 'jev-overlapping-options',
		meaning: 'Jev reads two options of a Choice as covering the same cases',
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV304: {
		code: 'JEV304',
		name: 'jev-overlapping-levels',
		meaning: 'Jev reads two levels of a Score as the same situation',
		severity: 'warning',
		docs: DOCS.scoreLevels,
	},
	JEV305: {
		code: 'JEV305',
		name: 'jev-label-mismatch',
		meaning:
			'Jev reads an option as named for one thing and described as another',
		severity: 'warning',
		docs: DOCS.choice,
	},
	JEV306: {
		code: 'JEV306',
		name: 'jev-criteria-off-topic',
		meaning:
			'Jev reads the criteria as deciding something the instructions do not ask',
		severity: 'info',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV307: {
		code: 'JEV307',
		name: 'jev-ordered-options',
		meaning:
			"Jev reads a Choice's options as steps on one scale, which a Score would place between",
		severity: 'info',
		docs: `${DOCS.primitives}#choose-a-question-type`,
	},
	JEV308: {
		code: 'JEV308',
		name: 'jev-unordered-levels',
		meaning:
			"Jev reads a Score's levels as unordered categories, which a Choice would pick from",
		severity: 'info',
		docs: `${DOCS.primitives}#choose-a-question-type`,
	},
	JEV309: {
		code: 'JEV309',
		name: 'jev-depends-on-sibling',
		meaning:
			"Jev reads a question as needing another question's answer from the same request",
		severity: 'info',
		docs: `${DOCS.primitives}#when-one-question-depends-on-another`,
	},
	JEV310: {
		code: 'JEV310',
		name: 'jev-overlapping-questions',
		meaning:
			'Jev reads two questions in one request as asking for the same judgment',
		severity: 'info',
		docs: `${DOCS.primitives}#ask-multiple-questions-together`,
	},
	JEV311: {
		code: 'JEV311',
		name: 'jev-answer-not-in-state',
		meaning:
			'Jev reads the state written in the file as not holding what the question asks about',
		severity: 'info',
		docs: 'https://docs.typesafe.ai/concepts/state',
	},
	JEV312: {
		code: 'JEV312',
		name: 'jev-orders-in-state',
		meaning:
			'Jev reads part of the state written in the file as giving orders to its reader',
		severity: 'info',
		docs: `${DOCS.jaggedness}#adversarial-content`,
	},
});

/** Rules in the JEV3xx range run only when the user asks Jev to check a file. `lintText` never runs them. */
export const RULE_CODES = Object.freeze(Object.keys(RULES) as RuleCode[]);

/**
 * A rule's own page: what it catches, an example, how to fix and silence it.
 * A finding links here, and the page links on to the vendor page in `docs`.
 * The pages are in `docs/rules/`, generated by `bun run docs:rules`.
 */
export function pageFor(code: string): string {
	return `https://github.com/nolindnaidoo/jevlint-le/blob/main/docs/rules/${code}.md`;
}
