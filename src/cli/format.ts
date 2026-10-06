import { pageFor, RULES } from '../lint/rules';
import type { ReportedFinding, Severity } from '../types';
import type { Format } from './args';

export type FileReport = Readonly<{
	path: string;
	text: string;
	findings: ReadonlyArray<ReportedFinding>;
	questionCount: number;
	unreadableCount: number;
}>;

export type Totals = Readonly<{
	files: number;
	questions: number;
	/** Questions with a part built at runtime, which no rule could read in full. */
	unreadable: number;
	/** Files a settings file leaves out with `exclude`. */
	excluded: number;
	/** Files left unread for being over the size limit. */
	skipped: ReadonlyArray<string>;
	/** Folders and files that could not be read at all. */
	unread: ReadonlyArray<string>;
	counts: Readonly<Record<Severity, number>>;
	/** Findings left that `--fix` would mend. */
	fixable: number;
	/** Present only under `--fix`: what was written. */
	fixed?: Readonly<{ findings: number; files: number }>;
	/** Present only when the run was asked to check with Jev. */
	jev?: JevTotals;
}>;

/** What a check with Jev sent, or under `--jev-plan` what it would send. */
export type JevTotals = Readonly<{
	/** False when the run only planned. */
	sent: boolean;
	/** Requests within the limit. */
	planned: number;
	answered: number;
	/** Questions with a part built at runtime, which Jev is never shown. */
	runtime: number;
	/** Requests left out for being past the limit. */
	overLimit: number;
	/** An estimate made before sending. */
	estimatedInputTokens: number;
	/** What TypeSafe counted. */
	inputTokens: number;
	model: string;
	/** True when state written in a file was sent, or would be. */
	state: boolean;
}>;

type Position = Readonly<{ line: number; column: number }>;

function lineStarts(text: string): ReadonlyArray<number> {
	const starts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1))
		starts.push(i + 1);
	return starts;
}

// One-based, as editors and CI annotations count.
function locate(starts: ReadonlyArray<number>, offset: number): Position {
	const after = starts.findIndex((start) => start > offset);
	const line = after === -1 ? starts.length : after;
	return { line, column: offset - (starts[line - 1] ?? 0) + 1 };
}

type Row = Readonly<{
	path: string;
	finding: ReportedFinding;
	start: Position;
	end: Position;
}>;

function rows(reports: ReadonlyArray<FileReport>): ReadonlyArray<Row> {
	return reports.flatMap((report) => {
		const starts = lineStarts(report.text);
		return report.findings.map((finding) => ({
			path: report.path,
			finding,
			start: locate(starts, finding.span.start),
			end: locate(starts, finding.span.end),
		}));
	});
}

export const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? '' : 's'}`;

/** One sentence that says what was read and what was not, so a short run never looks like a clean one. */
export function summarize(totals: Totals): string {
	const { counts } = totals;
	const found = counts.error + counts.warning + counts.info + counts.hint;
	const parts = [
		`${plural(found, 'finding')} (${plural(counts.error, 'error')}, ${plural(counts.warning, 'warning')})`,
		`in ${plural(totals.questions, 'question')} across ${plural(totals.files, 'file')}.`,
	];
	if (totals.unreadable)
		parts.push(
			`${plural(totals.unreadable, 'question')} could not be read in full.`,
		);
	if (totals.excluded)
		parts.push(`${plural(totals.excluded, 'file')} excluded by settings.`);
	if (totals.skipped.length)
		parts.push(
			`${plural(totals.skipped.length, 'file')} over the size limit not read: ${totals.skipped.join(', ')}.`,
		);
	if (totals.unread.length)
		parts.push(
			`${plural(totals.unread.length, 'path')} could not be read: ${totals.unread.join(', ')}.`,
		);
	if (totals.fixable) parts.push(`${totals.fixable} can be fixed with --fix.`);
	if (totals.fixed)
		parts.push(
			`Fixed ${plural(totals.fixed.findings, 'finding')} in ${plural(totals.fixed.files, 'file')}.`,
		);
	if (totals.jev) parts.push(...describeJev(totals.jev));
	return parts.join(' ');
}

/** What was held back from Jev, said the same way before a run and after it. */
export function heldBack(jev: JevTotals): string | undefined {
	const parts = [
		...(jev.runtime
			? [`${plural(jev.runtime, 'question')} built at runtime`]
			: []),
		...(jev.overLimit
			? [`${plural(jev.overLimit, 'request')} over the --jev-max-calls limit`]
			: []),
	];
	return parts.length ? `Not sent: ${parts.join(', ')}.` : undefined;
}

function describeJev(jev: JevTotals): ReadonlyArray<string> {
	const requests = plural(jev.planned, 'request');
	const state = jev.state ? ' State is sent.' : '';
	const said = jev.sent
		? `Jev answered ${jev.answered} of ${requests} on ${jev.model}, ${jev.inputTokens} input tokens.`
		: `--jev would send ${requests} to ${jev.model}, about ${jev.estimatedInputTokens} input tokens.${state}`;
	const held = heldBack(jev);
	return held ? [said, held] : [said];
}

type Paint = (code: number, text: string) => string;
const PLAIN: Paint = (_code, text) => text;
const ANSI: Paint = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const BOLD = 1;
const DIM = 2;
const UNDERLINE = 4;
const SEVERITY_COLORS: Readonly<Record<Severity, number>> = Object.freeze({
	error: 31,
	warning: 33,
	info: 34,
	hint: DIM,
});
const SEVERITY_WIDTH = 'warning'.length;

// Narrower than this and wrapping does more harm than the terminal's own.
const NARROWEST = 40;

// Broken between words to fit the terminal. Left alone, a long message runs
// back to the left edge and loses the indent that ties it to its finding.
function wrap(text: string, width: number | undefined): ReadonlyArray<string> {
	if (width === undefined || width < NARROWEST) return [text];
	const lines: string[] = [];
	let line = '';
	for (const word of text.split(' ')) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line);
			line = word;
			continue;
		}
		line = line ? `${line} ${word}` : word;
	}
	return [...lines, line];
}

// Grouped by file, as ESLint's default is, with the message on its own line:
// these messages say what to do about a finding and run long.
function asStylish(
	reports: ReadonlyArray<FileReport>,
	totals: Totals,
	{ paint, columns }: Look,
): string {
	const byPath = new Map<string, Row[]>();
	for (const row of rows(reports))
		byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
	const blocks = [...byPath].map(([path, found]) => {
		const places = found.map(({ start }) => `${start.line}:${start.column}`);
		const width = Math.max(...places.map((place) => place.length));
		const lines = found.flatMap(({ finding }, i) => [
			`  ${(places[i] ?? '').padStart(width)}  ${paint(SEVERITY_COLORS[finding.severity], finding.severity.padEnd(SEVERITY_WIDTH))}  ${paint(BOLD, finding.code)} ${paint(DIM, RULES[finding.code].name)}`,
			...wrap(
				finding.message,
				columns === undefined ? undefined : columns - width - 4,
			).map((line) => `  ${' '.repeat(width)}  ${line}`),
		]);
		return [paint(UNDERLINE, path), ...lines, ''].join('\n');
	});
	return [...blocks, summarize(totals), ''].join('\n');
}

function asCompact(reports: ReadonlyArray<FileReport>, totals: Totals): string {
	const lines = rows(reports).map(
		({ path, finding, start }) =>
			`${path}:${start.line}:${start.column}  ${finding.severity}  ${finding.code}  ${finding.message}`,
	);
	return [...lines, ...(lines.length ? [''] : []), summarize(totals), ''].join(
		'\n',
	);
}

/** The run as plain data: what `--format json` prints and what the MCP server returns. */
export function toReport(reports: ReadonlyArray<FileReport>, totals: Totals) {
	const byPath = new Map<string, Row[]>();
	for (const row of rows(reports))
		byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
	const files = reports.map((report) => ({
		path: report.path,
		questionCount: report.questionCount,
		unreadableCount: report.unreadableCount,
		findings: (byPath.get(report.path) ?? []).map(
			({ finding, start, end }) => ({
				code: finding.code,
				rule: RULES[finding.code].name,
				severity: finding.severity,
				message: finding.message,
				questionId: finding.questionId ?? null,
				line: start.line,
				column: start.column,
				endLine: end.line,
				endColumn: end.column,
				docs: RULES[finding.code].docs,
				page: pageFor(finding.code),
			}),
		),
	}));
	return { files, totals };
}

function asJson(reports: ReadonlyArray<FileReport>, totals: Totals): string {
	return `${JSON.stringify(toReport(reports, totals), null, 2)}\n`;
}

const GITHUB_LEVELS: Readonly<Record<Severity, string>> = Object.freeze({
	error: 'error',
	warning: 'warning',
	info: 'notice',
	hint: 'notice',
});

// GitHub reads `%`, newlines, and in a property also `:` and `,`, as syntax.
const escapeData = (text: string) =>
	text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (text: string) =>
	escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');

function asGithub(reports: ReadonlyArray<FileReport>, totals: Totals): string {
	const lines = rows(reports).map(({ path, finding, start, end }) => {
		const properties = [
			`file=${escapeProperty(path)}`,
			`line=${start.line}`,
			`col=${start.column}`,
			`endLine=${end.line}`,
			`endColumn=${end.column}`,
			`title=${escapeProperty(`${finding.code} ${RULES[finding.code].name}`)}`,
		].join(',');
		return `::${GITHUB_LEVELS[finding.severity]} ${properties}::${escapeData(finding.message)}`;
	});
	return [...lines, summarize(totals), ''].join('\n');
}

const SARIF_LEVELS: Readonly<Record<Severity, string>> = Object.freeze({
	error: 'error',
	warning: 'warning',
	info: 'note',
	hint: 'note',
});

// SARIF 2.1.0, the shape GitHub code scanning and most security dashboards
// read. Positions are one-based and the end column is the one after the last
// character, which is how `locate` already counts.
function asSarif(
	reports: ReadonlyArray<FileReport>,
	_totals: Totals,
	look: Look,
): string {
	const codes = Object.keys(RULES) as ReadonlyArray<keyof typeof RULES>;
	const results = rows(reports).map(({ path, finding, start, end }) => ({
		ruleId: finding.code,
		ruleIndex: codes.indexOf(finding.code),
		level: SARIF_LEVELS[finding.severity],
		message: { text: finding.message },
		locations: [
			{
				physicalLocation: {
					artifactLocation: { uri: path.replace(/\\/g, '/') },
					region: {
						startLine: start.line,
						startColumn: start.column,
						endLine: end.line,
						endColumn: end.column,
					},
				},
			},
		],
	}));
	const sarif = {
		$schema: 'https://json.schemastore.org/sarif-2.1.0.json',
		version: '2.1.0',
		runs: [
			{
				tool: {
					driver: {
						name: 'JevLint-LE',
						version: look.version,
						informationUri: 'https://github.com/nolindnaidoo/jevlint-le',
						rules: codes.map((code) => ({
							id: code,
							name: RULES[code].name,
							shortDescription: { text: RULES[code].name },
							// The rule's own page, which has an example and links on to the vendor page.
							helpUri: pageFor(code),
						})),
					},
				},
				results,
			},
		],
	};
	return `${JSON.stringify(sarif, null, 2)}\n`;
}

const escapeXml = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		// Characters XML 1.0 has no way to hold, which would make the file unreadable.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// JUnit XML, for the test reporters CI systems already have. One suite per
// file and one case per finding. Only an error is a failed case, because only
// an error fails a run: a warning is a passing case that carries its message.
function asJunit(reports: ReadonlyArray<FileReport>, totals: Totals): string {
	const byPath = new Map<string, Row[]>();
	for (const row of rows(reports))
		byPath.set(row.path, [...(byPath.get(row.path) ?? []), row]);
	const suites = reports.map((report) => {
		const found = byPath.get(report.path) ?? [];
		const failures = found.filter(
			({ finding }) => finding.severity === 'error',
		).length;
		const name = escapeXml(report.path);
		// A file with nothing to report is one passing case, so it still shows as checked.
		const cases = found.length
			? found.map(({ finding, start }) => {
					const title = escapeXml(
						`${finding.code} ${RULES[finding.code].name} (${start.line}:${start.column})`,
					);
					const said = escapeXml(finding.message);
					const body =
						finding.severity === 'error'
							? `<failure message="${said}" type="${finding.code}">${escapeXml(`${report.path}:${start.line}:${start.column}`)}</failure>`
							: `<system-out>${escapeXml(finding.severity)}: ${said}</system-out>`;
					return `    <testcase name="${title}" classname="${name}">${body}</testcase>`;
				})
			: [`    <testcase name="no findings" classname="${name}"/>`];
		return [
			`  <testsuite name="${name}" tests="${cases.length}" failures="${failures}" errors="0">`,
			...cases,
			'  </testsuite>',
		].join('\n');
	});
	const tests = reports.reduce(
		(all, report) => all + Math.max(1, (byPath.get(report.path) ?? []).length),
		0,
	);
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="jevlint-le" tests="${tests}" failures="${totals.counts.error}" errors="0">`,
		...suites,
		'</testsuites>',
		'',
	].join('\n');
}

/** How a format is drawn. Each format reads only what it needs. */
type Look = Readonly<{
	paint: Paint;
	/** The terminal's width, when one is reading. */
	columns: number | undefined;
	/** The tool's own version, for the formats that name the tool. */
	version: string;
}>;

type Formatter = (
	reports: ReadonlyArray<FileReport>,
	totals: Totals,
	look: Look,
) => string;

const FORMATTERS: Readonly<Record<Format, Formatter>> = Object.freeze({
	stylish: asStylish,
	compact: asCompact,
	json: asJson,
	github: asGithub,
	sarif: asSarif,
	junit: asJunit,
});

export type FormatOptions = Readonly<{
	/** Colour, which only the stylish format has. */
	color?: boolean;
	columns?: number | undefined;
	version?: string;
}>;

/** Only the stylish format is for a person. The others are read by programs. */
export function format(
	kind: Format,
	reports: ReadonlyArray<FileReport>,
	totals: Totals,
	options: FormatOptions = {},
): string {
	return FORMATTERS[kind](reports, totals, {
		paint: options.color ? ANSI : PLAIN,
		columns: options.columns,
		version: options.version ?? '',
	});
}
