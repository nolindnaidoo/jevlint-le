import { RULES } from '../lint/rules';
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
	/** Files left unread for being over the size limit. */
	skipped: ReadonlyArray<string>;
	/** Folders and files that could not be read at all. */
	unread: ReadonlyArray<string>;
	counts: Readonly<Record<Severity, number>>;
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
	if (totals.skipped.length)
		parts.push(
			`${plural(totals.skipped.length, 'file')} over the size limit not read: ${totals.skipped.join(', ')}.`,
		);
	if (totals.unread.length)
		parts.push(
			`${plural(totals.unread.length, 'path')} could not be read: ${totals.unread.join(', ')}.`,
		);
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

function asText(reports: ReadonlyArray<FileReport>, totals: Totals): string {
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

const FORMATTERS: Readonly<
	Record<Format, (reports: ReadonlyArray<FileReport>, totals: Totals) => string>
> = Object.freeze({ text: asText, json: asJson, github: asGithub });

export function format(
	kind: Format,
	reports: ReadonlyArray<FileReport>,
	totals: Totals,
): string {
	return FORMATTERS[kind](reports, totals);
}
