import type { RuleCode, Severity } from '../types';
import { DOCS } from './limits';

export type Rule = Readonly<{
	code: RuleCode;
	name: string;
	/** `off` for a rule the corpus has not earned a default for. It still runs when a user switches it on. */
	severity: Severity | 'off';
	docs: string;
}>;

/** The single list of rules. SPEC.md and README.md are held to it by `rules.test.ts`. */
export const RULES: Readonly<Record<RuleCode, Rule>> = Object.freeze({
	JEV000: {
		code: 'JEV000',
		name: 'unreadable',
		severity: 'hint',
		docs: DOCS.api,
	},
	JEV001: {
		code: 'JEV001',
		name: 'unpinned-model',
		severity: 'warning',
		docs: DOCS.models,
	},
	JEV002: {
		code: 'JEV002',
		name: 'choice-option-limit',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV003: {
		code: 'JEV003',
		name: 'score-level-limit',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV004: {
		code: 'JEV004',
		name: 'no-fallback-option',
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
		severity: 'error',
		docs: DOCS.api,
	},
	JEV006: {
		code: 'JEV006',
		name: 'criteria-shape',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV007: {
		code: 'JEV007',
		name: 'invalid-question',
		severity: 'error',
		docs: DOCS.api,
	},
	JEV008: {
		code: 'JEV008',
		name: 'numeric-levels',
		severity: 'warning',
		docs: DOCS.scoreLevels,
	},
	JEV009: {
		code: 'JEV009',
		name: 'too-few-options',
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV010: {
		code: 'JEV010',
		name: 'unused-disable',
		severity: 'warning',
		// The one rule about this tool's own comments, so the one with no vendor page.
		docs: 'https://github.com/nolindnaidoo/jevlint-le#suppressing-a-finding',
	},
	JEV011: {
		code: 'JEV011',
		name: 'description-repeats-name',
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
		// Measured: right 14 of 15 against 15 of 15, but less sure (0.73 against 0.87).
		severity: 'info',
		docs: `${DOCS.jaggedness}#indirection`,
	},
	JEV102: {
		code: 'JEV102',
		name: 'arithmetic',
		// Measured: counting 20 to 40 items, 8 of 12 at 0.58 sure. Adding three to five
		// numbers against a limit, 5 of 12 at 0.52. No better than a guess.
		severity: 'warning',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV103: {
		code: 'JEV103',
		name: 'date-comparison',
		// Measured: ordering two dates, 12 of 12. A window counted in days, 11 of 12 at
		// 0.75 sure, where code is certain. Advisory.
		severity: 'info',
		docs: `${DOCS.jaggedness}#date-and-time-comparison`,
	},
	JEV104: {
		code: 'JEV104',
		name: 'compound',
		severity: 'off',
		docs: `${DOCS.primitives}#ask-for-one-snap-judgment-per-question`,
	},
	JEV105: {
		code: 'JEV105',
		name: 'generation',
		severity: 'warning',
		docs: `${DOCS.jaggedness}#generation`,
	},
	JEV107: {
		code: 'JEV107',
		name: 'negated-noul',
		// Measured: 14 of 14 right either way, equally sure. No cost found.
		severity: 'off',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV108: {
		code: 'JEV108',
		name: 'inverted-criteria',
		// Measured: 14 of 14 right either way. Jev follows the question and ignores the criteria.
		severity: 'off',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV110: {
		code: 'JEV110',
		name: 'degree-levels',
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
		// Measured: 12 of 12 right with hex or with names, equally sure. No cost found.
		severity: 'off',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV112: {
		code: 'JEV112',
		name: 'undefined-boundary',
		// Measured: 4 of 6 right, against 6 of 6 once criteria drew the line.
		severity: 'info',
		docs: `${DOCS.jaggedness}#literal-reading`,
	},
	JEV301: {
		code: 'JEV301',
		name: 'jev-counting',
		severity: 'warning',
		docs: `${DOCS.jaggedness}#math-and-numbers`,
	},
	JEV302: {
		code: 'JEV302',
		name: 'jev-undefined-boundary',
		severity: 'info',
		docs: `${DOCS.jaggedness}#literal-reading`,
	},
	JEV303: {
		code: 'JEV303',
		name: 'jev-overlapping-options',
		severity: 'info',
		docs: DOCS.choice,
	},
	JEV304: {
		code: 'JEV304',
		name: 'jev-overlapping-levels',
		severity: 'warning',
		docs: DOCS.scoreLevels,
	},
	JEV305: {
		code: 'JEV305',
		name: 'jev-label-mismatch',
		severity: 'warning',
		docs: DOCS.choice,
	},
	JEV306: {
		code: 'JEV306',
		name: 'jev-criteria-off-topic',
		severity: 'info',
		docs: `${DOCS.jaggedness}#contradictory-instructions-and-criteria`,
	},
	JEV307: {
		code: 'JEV307',
		name: 'jev-ordered-options',
		severity: 'info',
		docs: `${DOCS.primitives}#choose-a-question-type`,
	},
	JEV308: {
		code: 'JEV308',
		name: 'jev-unordered-levels',
		severity: 'info',
		docs: `${DOCS.primitives}#choose-a-question-type`,
	},
	JEV309: {
		code: 'JEV309',
		name: 'jev-depends-on-sibling',
		severity: 'info',
		docs: `${DOCS.primitives}#when-one-question-depends-on-another`,
	},
	JEV310: {
		code: 'JEV310',
		name: 'jev-overlapping-questions',
		severity: 'info',
		docs: `${DOCS.primitives}#ask-multiple-questions-together`,
	},
	JEV311: {
		code: 'JEV311',
		name: 'jev-answer-not-in-state',
		severity: 'info',
		docs: 'https://docs.typesafe.ai/concepts/state',
	},
	JEV312: {
		code: 'JEV312',
		name: 'jev-orders-in-state',
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
