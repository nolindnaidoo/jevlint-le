import {
	createConfigLoader,
	folderOf,
	isExcluded,
	parseConfig,
} from '../config/projectConfig';
import { ENV_KEY, type Fetch } from '../jev/client';
import { fixText } from '../lint/fixAll';
import {
	DEFAULT_FALLBACK_OPTIONS,
	lintText,
	MAX_FILE_SIZE_BYTES,
	syntaxForPath,
} from '../lint/lint';
import type { LintOptions, Severity } from '../types';
import { type CliOptions, helpText, parseArgs } from './args';
import { type Files, findFiles } from './files';
import {
	type FileReport,
	format,
	heldBack,
	type JevTotals,
	plural,
	type Totals,
} from './format';
import { FAILURES, planJev, runJev } from './jev';
import { serve } from './mcp';

export type Io = Readonly<{
	files: Files;
	stdin: () => Promise<string>;
	/** Standard input a line at a time, for the MCP server. */
	lines: () => AsyncIterable<string>;
	out: (text: string) => void;
	err: (text: string) => void;
	version: string;
	/** The environment, read only for the API key and only under `--jev`. */
	env: Readonly<Record<string, string | undefined>>;
	/** The network, used only under `--jev`. */
	fetch: Fetch;
	wait: (ms: number) => Promise<void>;
	/** True when a terminal is reading standard output. */
	terminal: boolean;
	/** That terminal's width in characters. Undefined when there is none. */
	columns?: number | undefined;
	/** Aborts when the user stops the run. Asked for only when requests are about to be sent. */
	stopSignal: () => AbortSignal;
}>;

export const EXIT = Object.freeze({ passed: 0, failed: 1, unusable: 2 });

// A flag wins. Otherwise colour is for a terminal, unless NO_COLOR asks for none.
function colored(options: CliOptions, io: Io): boolean {
	if (options.color !== undefined) return options.color;
	return io.terminal && !io.env.NO_COLOR;
}

const BASE: LintOptions = Object.freeze({
	rules: {},
	fallbackOptions: DEFAULT_FALLBACK_OPTIONS,
	ignore: [],
});

export type Overrides = Readonly<{
	/** A settings file named outright, used for every file in place of one found near it. */
	config?: string | undefined;
	/** Rule levels given for this run. They win over any file. */
	rules: LintOptions['rules'];
}>;

/**
 * The settings that apply to one file: the file named with `--config`, or
 * else the `jevlint-le.json` nearest to it, looking no higher than the
 * directory the run started in. A sentence in place of settings says why a
 * settings file could not be used.
 */
export function createOptions(files: Files, overrides: Overrides) {
	return createSettings(files, overrides).optionsFor;
}

export type Settings = Readonly<{
	optionsFor: (file: string) => LintOptions | string;
	/** True when the settings file that governs a file leaves it out. */
	excludes: (file: string) => boolean;
}>;

export function createSettings(files: Files, overrides: Overrides): Settings {
	const loader = createConfigLoader({
		isFile: (path) => files.stat(path)?.kind === 'file',
		read: files.read,
	});
	// A named settings file stands in for one at the top of the run.
	const excludes = (file: string): boolean => {
		if (overrides.config !== undefined) {
			const options = named(overrides.config);
			return (
				typeof options !== 'string' && isExcluded(options.exclude, '.', file)
			);
		}
		const found = loader.for(file);
		return (
			found !== undefined &&
			typeof found.options !== 'string' &&
			isExcluded(found.options.exclude, folderOf(found.path), file)
		);
	};
	const withFlags = (options: LintOptions): LintOptions => ({
		...options,
		// A flag is the more specific instruction, so it wins over the file.
		rules: { ...options.rules, ...overrides.rules },
	});
	const named = (path: string): LintOptions | string => {
		if (files.stat(path)?.kind !== 'file')
			return `No such config file: ${path}`;
		const options = parseConfig(readOrNothing(files, path));
		return typeof options === 'string'
			? `${path}: ${options}`
			: withFlags(options);
	};
	const optionsFor = (file: string): LintOptions | string => {
		if (overrides.config !== undefined) return named(overrides.config);
		const found = loader.for(file);
		if (!found) return withFlags(BASE);
		return typeof found.options === 'string'
			? `${found.path}: ${found.options}`
			: withFlags(found.options);
	};
	return { optionsFor, excludes };
}

/** The sources a settings file does not leave out, and how many it does. */
export function withoutExcluded(
	sources: ReadonlyArray<Source>,
	settings: Settings,
): Readonly<{ sources: ReadonlyArray<Source>; excluded: number }> {
	const kept = sources.filter((source) => !settings.excludes(source.path));
	return { sources: kept, excluded: sources.length - kept.length };
}

function readOrNothing(files: Files, path: string): string | undefined {
	try {
		return files.read(path);
	} catch {
		return undefined;
	}
}

export type Source = Readonly<{ path: string; text: string }>;
/** What a run did not read, and so cannot speak for. */
export type Left = Readonly<{
	/** Files a settings file leaves out. */
	excluded?: number;
	/** Files over the size limit. */
	skipped: ReadonlyArray<string>;
	/** Folders and files that could not be read or linted. */
	unread: ReadonlyArray<string>;
}>;
type Gathered =
	| Readonly<{ sources: ReadonlyArray<Source>; left: Left }>
	| string;

/** The files under the given paths, read, with any too large to read named. */
export function gatherPaths(
	paths: ReadonlyArray<string>,
	files: Files,
	allowNone = false,
): Gathered {
	const found = findFiles(paths, files);
	if (!found.ok) return found.error;
	const small = (path: string) =>
		(files.stat(path)?.size ?? 0) <= MAX_FILE_SIZE_BYTES;
	const unread = [...found.unread];
	const sources: Source[] = [];
	for (const path of found.paths.filter(small)) {
		// A file that vanished or may not be read is named and the run goes on.
		try {
			sources.push({ path, text: files.read(path) });
		} catch {
			unread.push(path);
		}
	}
	// A run that read nothing has checked nothing, and must not pass.
	if (!found.paths.length && !unread.length && !allowNone)
		return 'No files to lint in the given paths.';
	if (!sources.length && unread.length)
		return `No files could be read. Not readable: ${unread.join(', ')}.`;
	return {
		sources,
		left: { skipped: found.paths.filter((path) => !small(path)), unread },
	};
}

async function gather(options: CliOptions, io: Io): Promise<Gathered> {
	const name = options.stdinFilename;
	if (name === undefined)
		return gatherPaths(
			options.paths.length ? options.paths : ['.'],
			io.files,
			options.allowNoFiles,
		);
	if (options.paths.length)
		return '--stdin-filename cannot be combined with paths.';
	if (!syntaxForPath(name)) return `Not a file type jevlint-le reads: ${name}`;
	const text = await io.stdin();
	// The limit a file is held to, so piped text cannot be the way around it.
	if (Buffer.byteLength(text, 'utf8') > MAX_FILE_SIZE_BYTES)
		return `Standard input is over the size limit of ${MAX_FILE_SIZE_BYTES} bytes.`;
	return {
		sources: [{ path: name, text }],
		left: { skipped: [], unread: [] },
	};
}

type Mended = Readonly<{
	sources: ReadonlyArray<Source>;
	fixed: NonNullable<Totals['fixed']>;
}>;

/** Writes the safe fixes into each file and hands back the text as it now is. */
function fixSources(
	sources: ReadonlyArray<Source>,
	optionsFor: (file: string) => LintOptions | string,
	files: Files,
): Mended | string {
	const mended: Source[] = [];
	let findings = 0;
	let changed = 0;
	for (const source of sources) {
		const options = optionsFor(source.path);
		if (typeof options === 'string') return options;
		const result = attemptFix(source, options);
		if (!result.fixed) {
			mended.push(source);
			continue;
		}
		try {
			files.write(source.path, result.text);
		} catch {
			// Files before this one are already written, so the run says where it stopped.
			return `Could not write ${source.path}. Files before it were fixed.`;
		}
		mended.push({ path: source.path, text: result.text });
		findings += result.fixed;
		changed += 1;
	}
	return { sources: mended, fixed: { findings, files: changed } };
}

// A file the reader fails on is left as it is. Linting names it afterwards.
function attemptFix(source: Source, options: LintOptions) {
	try {
		return fixText(source.text, options, syntaxForPath(source.path));
	} catch {
		return { text: source.text, fixed: 0 };
	}
}

export function lintSource(
	source: Source,
	lintOptions: LintOptions,
	quiet: boolean,
): FileReport {
	const result = lintText(source.text, lintOptions, syntaxForPath(source.path));
	return {
		...source,
		findings: quiet
			? result.findings.filter((finding) => finding.severity === 'error')
			: result.findings,
		questionCount: result.questionCount,
		unreadableCount: result.unreadableCount,
	};
}

export type Linted = Readonly<{
	reports: ReadonlyArray<FileReport>;
	/** Files the linter itself failed on. Named, never passed over. */
	failed: ReadonlyArray<string>;
}>;

/** Lints each source under the settings that apply to it, or says which settings file could not be used. */
export function lintSources(
	sources: ReadonlyArray<Source>,
	optionsFor: (file: string) => LintOptions | string,
	quiet: boolean,
): Linted | string {
	const reports: FileReport[] = [];
	const failed: string[] = [];
	for (const source of sources) {
		const options = optionsFor(source.path);
		if (typeof options === 'string') return options;
		// A file the reader cannot get through must not take the other files' findings with it.
		try {
			reports.push(lintSource(source, options, quiet));
		} catch {
			failed.push(source.path);
		}
	}
	return { reports, failed };
}

export function total(reports: ReadonlyArray<FileReport>, left: Left): Totals {
	const counts: Record<Severity, number> = {
		error: 0,
		warning: 0,
		info: 0,
		hint: 0,
	};
	for (const report of reports)
		for (const finding of report.findings) counts[finding.severity] += 1;
	const sum = (pick: (report: FileReport) => number) =>
		reports.reduce((all, report) => all + pick(report), 0);
	return {
		files: reports.length,
		questions: sum((report) => report.questionCount),
		unreadable: sum((report) => report.unreadableCount),
		excluded: left.excluded ?? 0,
		skipped: left.skipped,
		unread: left.unread,
		counts,
		fixable: reports.reduce(
			(all, report) =>
				all + report.findings.filter((finding) => finding.fix?.safe).length,
			0,
		),
	};
}

function fails(totals: Totals, maxWarnings: number | undefined): boolean {
	if (totals.counts.error) return true;
	return maxWarnings !== undefined && totals.counts.warning > maxWarnings;
}

/** Runs the tool on the arguments after the program name and returns the exit status. */
export async function run(
	argv: ReadonlyArray<string>,
	io: Io,
): Promise<number> {
	const unusable = (message: string) => {
		io.err(`jevlint-le: ${message}\n`);
		return EXIT.unusable;
	};
	const parsed = parseArgs(argv);
	if (!parsed.ok) return unusable(`${parsed.error} Try --help.`);
	const { options } = parsed;
	if (options.help) {
		io.out(helpText());
		return EXIT.passed;
	}
	if (options.version) {
		io.out(`${io.version}\n`);
		return EXIT.passed;
	}
	const refused = refuseJev(options, io) ?? refuseFix(options);
	if (refused) return unusable(refused);
	if (options.mcp) {
		await serve(io);
		return EXIT.passed;
	}
	const gathered = await gather(options, io);
	if (typeof gathered === 'string') return unusable(gathered);

	const settings = createSettings(io.files, options);
	const { optionsFor } = settings;
	// Piped text was handed over on purpose, so no settings file leaves it out.
	const kept =
		options.stdinFilename === undefined
			? withoutExcluded(gathered.sources, settings)
			: { sources: gathered.sources, excluded: 0 };
	const mended = options.fix
		? fixSources(kept.sources, optionsFor, io.files)
		: undefined;
	if (typeof mended === 'string') return unusable(mended);
	const linted = lintSources(
		mended?.sources ?? kept.sources,
		optionsFor,
		options.quiet,
	);
	if (typeof linted === 'string') return unusable(linted);
	const fixed = mended ? { fixed: mended.fixed } : {};
	const { reports } = linted;
	const left: Left = {
		excluded: kept.excluded,
		skipped: gathered.left.skipped,
		unread: [...gathered.left.unread, ...linted.failed],
	};
	if (options.jev || options.jevPlan)
		return runWithJev(options, io, reports, left, optionsFor, fixed);
	const totals = { ...total(reports, left), ...fixed };
	io.out(
		format(options.format, reports, totals, colored(options, io), io.columns),
	);
	return fails(totals, options.maxWarnings) ? EXIT.failed : EXIT.passed;
}

const JEV_ONLY: ReadonlyArray<readonly [keyof CliOptions, string]> = [
	['jevModel', '--jev-model'],
	['jevMaxCalls', '--jev-max-calls'],
	['jevSendState', '--jev-send-state'],
];

/** Why the Jev flags given cannot be run as given, before anything is read. */
function refuseJev(options: CliOptions, io: Io): string | undefined {
	const asks = options.jev || options.jevPlan;
	const stray = JEV_ONLY.find(([key]) => options[key]);
	if (!asks && stray) return `${stray[1]} needs --jev or --jev-plan.`;
	if (asks && options.mcp)
		return '--jev cannot be combined with --mcp. The server sends nothing.';
	if (options.jev && !options.jevPlan && !io.env[ENV_KEY]?.trim())
		return `--jev needs an API key in ${ENV_KEY}. Nothing was sent.`;
	return undefined;
}

function refuseFix(options: CliOptions): string | undefined {
	if (!options.fix) return undefined;
	if (options.mcp) return '--fix cannot be combined with --mcp.';
	// Piped text has no file to write the fix back to.
	if (options.stdinFilename !== undefined)
		return '--fix cannot be combined with --stdin-filename.';
	return undefined;
}

const sending = (jev: JevTotals): string =>
	[
		`Sending ${plural(jev.planned, 'request')} to TypeSafe on ${jev.model}, about ${jev.estimatedInputTokens} input tokens.`,
		jev.state ? 'State is sent.' : 'State is not sent.',
		...[heldBack(jev) ?? []].flat(),
	].join(' ');

// A run that checked part of what it was asked to must not pass as the whole.
function shortfall(
	jev: JevTotals,
	failure: string | undefined,
	stopped: boolean,
): string | undefined {
	const of = `${jev.answered} of ${plural(jev.planned, 'request')}`;
	if (failure) return `${failure}. Jev answered ${of}.`;
	if (stopped) return `Stopped. Jev answered ${of}.`;
	if (jev.overLimit)
		return `${plural(jev.overLimit, 'request')} over the --jev-max-calls limit not sent. Raise the limit to check every question.`;
	return undefined;
}

async function runWithJev(
	options: CliOptions,
	io: Io,
	linted: ReadonlyArray<FileReport>,
	left: Left,
	optionsFor: (file: string) => LintOptions | string,
	fixed: Pick<Totals, 'fixed'>,
): Promise<number> {
	const say = (message: string) => io.err(`jevlint-le: ${message}\n`);
	const plan = planJev(linted, optionsFor, options);
	if (typeof plan === 'string') {
		say(plan);
		return EXIT.unusable;
	}
	if (options.jevPlan) {
		const totals = { ...total(linted, left), ...fixed, jev: plan.totals };
		io.out(
			format(options.format, linted, totals, colored(options, io), io.columns),
		);
		return fails(totals, options.maxWarnings) ? EXIT.failed : EXIT.passed;
	}
	if (plan.totals.planned) say(sending(plan.totals));
	const ran = await runJev(
		plan,
		{
			fetch: io.fetch,
			wait: io.wait,
			key: (io.env[ENV_KEY] ?? '').trim(),
			signal: io.stopSignal(),
		},
		options.quiet,
	);
	const totals = { ...total(ran.reports, left), ...fixed, jev: ran.totals };
	io.out(
		format(
			options.format,
			ran.reports,
			totals,
			colored(options, io),
			io.columns,
		),
	);
	const failure =
		ran.failure && `${FAILURES[ran.failure.kind]} (${ran.failure.detail})`;
	const short = shortfall(ran.totals, failure, ran.stopped);
	if (short) {
		say(short);
		return EXIT.unusable;
	}
	return fails(totals, options.maxWarnings) ? EXIT.failed : EXIT.passed;
}
