import { DEFAULT_MODEL } from '../jev/review';
import { REQUEST_REVIEWS, REVIEWS } from '../jev/reviews';
import { lintText } from '../lint/lint';
import { RULE_CODES, RULES } from '../lint/rules';
import type { LintOptions, RuleCode, Syntax } from '../types';

/**
 * A page per rule, written from the registry, the README's table and a pair
 * of examples the linter itself is run on. Nothing on a page is typed by
 * hand, so a page cannot drift from the rule it describes: change the rule
 * and `bun run docs:rules` rewrites it, and a test fails until it is run.
 */

export type RuleExample =
	| Readonly<{ syntax: string; bad: string; good: string }>
	| Readonly<{ note: string }>;

export type RuleExamples = Readonly<Record<string, RuleExample>>;

const FENCE = '```';
const READERS: Readonly<Record<string, Syntax>> = Object.freeze({
	json: 'js',
	js: 'js',
	python: 'python',
});

// Every rule on, so an example shows its finding whatever the rule's default is.
const ALL_ON: LintOptions = Object.freeze({
	rules: Object.fromEntries(RULE_CODES.map((code) => [code, 'warning'])),
	fallbackOptions: ['other', 'none'],
	ignore: [],
});

/** What the linter reports of one rule in an example. */
export function findingsOf(code: RuleCode, text: string, syntax: string) {
	return lintText(text, ALL_ON, READERS[syntax] ?? 'js').findings.filter(
		(finding) => finding.code === code,
	);
}

// The "What it means" column of the README's rule tables, by code.
function meanings(readme: string): ReadonlyMap<string, string> {
	const rows = readme.matchAll(
		/^\| (JEV\d{3}) \| [^|]+ \| [^|]+ \| (.+) \|$/gm,
	);
	return new Map([...rows].map((row) => [row[1] as string, row[2] as string]));
}

const jevBacked = (code: string) => code.startsWith('JEV3');
const wording = (code: string) => code > 'JEV100' && code < 'JEV300';

function kind(code: RuleCode): string {
	if (jevBacked(code))
		return 'Asks Jev. It runs only under **Check This File with Jev** in the editor or `--jev` on the command line, with your key, and never while linting.';
	if (wording(code))
		return 'A wording rule. It matches patterns in English text, so it can miss a defect or flag a question that is fine.';
	return 'An exact rule. It reads the shape of the question and does not guess.';
}

function level(code: RuleCode): string {
	const { severity } = RULES[code];
	if (severity !== 'off') return `On by default, as \`${severity}\`.`;
	return `Off by default. Turn it on in \`jevlint-le.json\` with \`{ "rules": { "${code}": "warning" } }\`.`;
}

function fixing(code: RuleCode, example: RuleExample | undefined): string {
	const fix =
		example && 'bad' in example
			? findingsOf(code, example.bad, example.syntax)[0]?.fix
			: undefined;
	if (!fix) return 'There is no automatic fix. The change is yours to make.';
	return fix.safe
		? `\`--fix\` and fix on save mend this: ${fix.title}.`
		: `A quick fix is offered on the lightbulb: ${fix.title}. It is never applied by \`--fix\` or on save, because it changes what a working request does.`;
}

function examples(code: RuleCode, example: RuleExample | undefined): string {
	if (jevBacked(code)) return asked(code);
	if (!example) return '';
	if ('note' in example) return `## Example\n\n${example.note}\n`;
	const said = findingsOf(code, example.bad, example.syntax)[0]?.message ?? '';
	return [
		'## Flagged',
		'',
		`${FENCE}${example.syntax}`,
		example.bad,
		FENCE,
		'',
		`> ${said}`,
		'',
		'## Not flagged',
		'',
		`${FENCE}${example.syntax}`,
		example.good,
		FENCE,
		'',
	].join('\n');
}

// What a Jev-backed check puts to Jev, since no example of one can be checked offline.
function asked(code: RuleCode): string {
	const review = REVIEWS.find((candidate) => candidate.code === code);
	const whole = (
		REQUEST_REVIEWS as Readonly<Record<string, { cutoff: number }>>
	)[code];
	const cutoff = review?.cutoff ?? whole?.cutoff;
	const lines = ['## What Jev is asked', ''];
	if (review) lines.push(`> ${review.instructions}`, '');
	if (!review)
		lines.push(
			'This one is asked about a whole request, not one question: every pair of questions, or the state written in the file.',
			'',
		);
	lines.push(
		`It is reported when Jev puts the probability of yes at ${cutoff} or more. That cutoff was set from a small number of examples on \`${DEFAULT_MODEL}\`, so treat a finding as an argument with a number attached, not a verdict.`,
		'',
	);
	return lines.join('\n');
}

function silence(code: RuleCode): string {
	if (code === 'JEV010')
		return 'Remove the comment it points at. To stop the rule itself, set it to `off` in `jevlint-le.json`.\n';
	return [
		'In code, on the line above:',
		'',
		`${FENCE}ts`,
		`// jevlint-le-disable-next-line ${code}`,
		FENCE,
		'',
		'In JSON, which has no comments, by question id in `jevlint-le.json`:',
		'',
		`${FENCE}json`,
		`{ "ignore": ["${code}:your-question-id"] }`,
		FENCE,
		'',
	].join('\n');
}

function page(
	code: RuleCode,
	meaning: string,
	example: RuleExample | undefined,
): string {
	const rule = RULES[code];
	return [
		`# ${code} ${rule.name}`,
		'',
		`${meaning}.`,
		'',
		`${level(code)} ${kind(code)}`,
		'',
		examples(code, example),
		'## Fixing it',
		'',
		fixing(code, example),
		'',
		'## Silencing it',
		'',
		silence(code),
		'## Source',
		'',
		code === 'JEV010'
			? "This rule is about the linter's own comments, so it has no vendor page."
			: `[${rule.docs}](${rule.docs})`,
		'',
		'[All rules](README.md)',
		'',
	].join('\n');
}

function index(means: ReadonlyMap<string, string>): string {
	const rows = RULE_CODES.map(
		(code) =>
			`| [${code}](${code}.md) | ${RULES[code].name} | ${RULES[code].severity} | ${means.get(code) ?? ''} |`,
	);
	return [
		'# Rules',
		'',
		'One page per rule: what it catches, an example the linter is run on, how to fix it and how to silence it. These pages are generated by `bun run docs:rules`.',
		'',
		'| Code | Name | Default | What it means |',
		'|---|---|---|---|',
		...rows,
		'',
	].join('\n');
}

/** Every page, by file name, as it should be on disk under `docs/rules/`. */
export function renderRulePages(
	readme: string,
	given: RuleExamples,
): Readonly<Record<string, string>> {
	const means = meanings(readme);
	const pages = RULE_CODES.map(
		(code) =>
			[`${code}.md`, page(code, means.get(code) ?? '', given[code])] as const,
	);
	return Object.fromEntries([['README.md', index(means)], ...pages]);
}
