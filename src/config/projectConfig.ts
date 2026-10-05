import { DEFAULT_FALLBACK_OPTIONS } from '../lint/lint';
import { RULE_CODES } from '../lint/rules';
import type { LintOptions, RuleCode, Severity } from '../types';

/**
 * The project's lint settings, kept in the repository so that the editor and
 * the command line apply the same rules. Without it a rule switched off in
 * one would still fail in the other.
 */
export const CONFIG_FILE = 'jevlint-le.json';
export const CONFIG_KEYS: ReadonlyArray<string> = [
	'rules',
	'fallbackOptions',
	'ignore',
];
export const LEVELS: ReadonlyArray<string> = [
	'off',
	'hint',
	'info',
	'warning',
	'error',
];

type Level = Severity | 'off';
const CODES: ReadonlySet<string> = new Set(RULE_CODES);

/** A `CODE=level` pair, or the reason it is not one. */
export function readRule(text: string): readonly [RuleCode, Level] | string {
	const [code = '', level = ''] = text.split('=');
	if (!CODES.has(code)) return `'${code}' is not a rule code.`;
	if (!LEVELS.includes(level))
		return `'${level}' is not a level. Use one of ${LEVELS.join(', ')}.`;
	return [code as RuleCode, level as Level];
}

/** A map of rule code to level, or the reason it is not one. */
export function readRules(value: unknown): LintOptions['rules'] | string {
	if (value === undefined) return {};
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return "'rules' must be an object of rule code to level.";
	const rules: Record<string, string> = {};
	for (const [code, level] of Object.entries(value)) {
		const rule = readRule(`${code}=${String(level)}`);
		if (typeof rule === 'string') return `rules: ${rule}`;
		rules[rule[0]] = rule[1];
	}
	return rules as LintOptions['rules'];
}

const UNREADABLE = 'it could not be read.';

const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === 'string');

/**
 * The settings in a config file, checked strictly. A misspelt key that was
 * quietly ignored would leave a rule on that the author believes is off.
 */
export function parseConfig(text: string | undefined): LintOptions | string {
	if (text === undefined) return UNREADABLE;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return 'it is not valid JSON.';
	}
	if (!data || typeof data !== 'object' || Array.isArray(data))
		return 'it must hold a JSON object.';
	const config = data as Record<string, unknown>;
	const unknown = Object.keys(config).find((key) => !CONFIG_KEYS.includes(key));
	if (unknown)
		return `'${unknown}' is not a setting. Use ${CONFIG_KEYS.join(', ')}.`;
	const rules = readRules(config.rules);
	if (typeof rules === 'string') return rules;
	const { fallbackOptions = DEFAULT_FALLBACK_OPTIONS, ignore = [] } = config;
	if (!isStrings(fallbackOptions))
		return "'fallbackOptions' must be a list of strings.";
	if (!isStrings(ignore)) return "'ignore' must be a list of strings.";
	return { rules, fallbackOptions, ignore };
}

export type ConfigFs = Readonly<{
	isFile: (path: string) => boolean;
	read: (path: string) => string;
}>;

/** A config file that applies to a path: where it is, and its settings or what is wrong with it. */
export type ProjectConfig = Readonly<{
	path: string;
	options: LintOptions | string;
}>;

export type ConfigLoader = Readonly<{
	/**
	 * The config file nearest to `file`, looking in its directory and each one
	 * above it up to `stop`. Undefined when there is none.
	 */
	for: (file: string, stop?: string) => ProjectConfig | undefined;
	/** Forgets what was read, for when a config file is written, added or removed. */
	clear: () => void;
}>;

// The directory a path is in, by whichever separator the path uses. Node's own
// function for this reads only the running platform's, so a Windows path on
// another system, or a forward-slash path on Windows, would be read wrongly.
function parent(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	if (cut === -1) return '.';
	// The root is its own parent: `/`, or a drive such as `C:\\`.
	const drive = cut === 2 && path[1] === ':';
	return cut === 0 || drive ? path.slice(0, cut + 1) : path.slice(0, cut);
}

// The settings file in a directory, written with the separator the directory
// already uses. `path.join` would rewrite every separator to the platform's,
// and a path handed in with forward slashes on Windows would come back changed.
function beside(dir: string): string {
	if (dir === '.') return CONFIG_FILE;
	const separator = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
	return dir.endsWith(separator)
		? `${dir}${CONFIG_FILE}`
		: `${dir}${separator}${CONFIG_FILE}`;
}

// A settings file can vanish or lose its permissions between being found and
// being read. That is a file that cannot be used, said the way a bad one is.
function readOr(fs: ConfigFs, path: string): string | undefined {
	try {
		return fs.read(path);
	} catch {
		return undefined;
	}
}

export function createConfigLoader(fs: ConfigFs): ConfigLoader {
	const parsed = new Map<string, ProjectConfig>();

	const load = (path: string): ProjectConfig => {
		const known = parsed.get(path);
		if (known) return known;
		const config = { path, options: parseConfig(readOr(fs, path)) };
		parsed.set(path, config);
		return config;
	};

	const find = (
		file: string,
		stop: string | undefined,
	): ProjectConfig | undefined => {
		let dir = parent(file);
		while (true) {
			const candidate = beside(dir);
			if (fs.isFile(candidate)) return load(candidate);
			const above = parent(dir);
			// The top of the search: the boundary given, or where the path runs out.
			if (dir === stop || above === dir) return undefined;
			dir = above;
		}
	};

	return Object.freeze({ for: find, clear: () => parsed.clear() });
}
