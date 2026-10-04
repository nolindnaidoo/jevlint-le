import { createConfigLoader, parseConfig } from '../config/projectConfig';
import {
	DEFAULT_FALLBACK_OPTIONS,
	lintText,
	MAX_FILE_SIZE_BYTES,
	syntaxForPath,
} from '../lint/lint';
import type { LintOptions, Severity } from '../types';
import { type CliOptions, helpText, parseArgs } from './args';
import { type Files, findFiles } from './files';
import { type FileReport, format, type Totals } from './format';
import { serve } from './mcp';

export type Io = Readonly<{
	files: Files;
	stdin: () => Promise<string>;
	/** Standard input a line at a time, for the MCP server. */
	lines: () => AsyncIterable<string>;
	out: (text: string) => void;
	err: (text: string) => void;
	version: string;
}>;

export const EXIT = Object.freeze({ passed: 0, failed: 1, unusable: 2 });

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
	const loader = createConfigLoader({
		isFile: (path) => files.stat(path)?.kind === 'file',
		read: files.read,
	});
	const withFlags = (options: LintOptions): LintOptions => ({
		...options,
		// A flag is the more specific instruction, so it wins over the file.
		rules: { ...options.rules, ...overrides.rules },
	});
	const named = (path: string): LintOptions | string => {
		if (files.stat(path)?.kind !== 'file')
			return `No such config file: ${path}`;
		const options = parseConfig(files.read(path));
		return typeof options === 'string'
			? `${path}: ${options}`
			: withFlags(options);
	};
	return (file: string): LintOptions | string => {
		if (overrides.config !== undefined) return named(overrides.config);
		const found = loader.for(file);
		if (!found) return withFlags(BASE);
		return typeof found.options === 'string'
			? `${found.path}: ${found.options}`
			: withFlags(found.options);
	};
}

export type Source = Readonly<{ path: string; text: string }>;
type Gathered =
	| Readonly<{ sources: ReadonlyArray<Source>; skipped: ReadonlyArray<string> }>
	| string;

/** The files under the given paths, read, with any too large to read named. */
export function gatherPaths(
	paths: ReadonlyArray<string>,
	files: Files,
): Gathered {
	const found = findFiles(paths, files);
	if (!found.ok) return found.error;
	// A run that read nothing has checked nothing, and must not pass.
	if (!found.paths.length) return 'No files to lint in the given paths.';
	const small = (path: string) =>
		(files.stat(path)?.size ?? 0) <= MAX_FILE_SIZE_BYTES;
	return {
		sources: found.paths
			.filter(small)
			.map((path) => ({ path, text: files.read(path) })),
		skipped: found.paths.filter((path) => !small(path)),
	};
}

async function gather(options: CliOptions, io: Io): Promise<Gathered> {
	const name = options.stdinFilename;
	if (name === undefined)
		return gatherPaths(options.paths.length ? options.paths : ['.'], io.files);
	if (options.paths.length)
		return '--stdin-filename cannot be combined with paths.';
	if (!syntaxForPath(name)) return `Not a file type jevlint-le reads: ${name}`;
	return { sources: [{ path: name, text: await io.stdin() }], skipped: [] };
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

/** Lints each source under the settings that apply to it, or says which settings file could not be used. */
export function lintSources(
	sources: ReadonlyArray<Source>,
	optionsFor: (file: string) => LintOptions | string,
	quiet: boolean,
): ReadonlyArray<FileReport> | string {
	const reports: FileReport[] = [];
	for (const source of sources) {
		const options = optionsFor(source.path);
		if (typeof options === 'string') return options;
		reports.push(lintSource(source, options, quiet));
	}
	return reports;
}

export function total(
	reports: ReadonlyArray<FileReport>,
	skipped: ReadonlyArray<string>,
): Totals {
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
		skipped,
		counts,
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
	if (options.mcp) {
		await serve(io);
		return EXIT.passed;
	}
	const gathered = await gather(options, io);
	if (typeof gathered === 'string') return unusable(gathered);

	const linted = lintSources(
		gathered.sources,
		createOptions(io.files, options),
		options.quiet,
	);
	if (typeof linted === 'string') return unusable(linted);
	const reports = linted;
	const totals = total(reports, gathered.skipped);
	io.out(format(options.format, reports, totals));
	return fails(totals, options.maxWarnings) ? EXIT.failed : EXIT.passed;
}
