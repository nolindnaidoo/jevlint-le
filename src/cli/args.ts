import { LEVELS, readRule } from '../config/projectConfig';
import { ENV_KEY } from '../jev/client';
import { DEFAULT_MAX_CALLS, DEFAULT_MODEL } from '../jev/review';
import type { LintOptions } from '../types';

export type Format = 'text' | 'json' | 'github';

export type CliOptions = Readonly<{
	paths: ReadonlyArray<string>;
	format: Format;
	rules: LintOptions['rules'];
	config: string | undefined;
	/** The most warnings a run may report and still pass. Undefined is no limit. */
	maxWarnings: number | undefined;
	/** Read the text from standard input and treat it as this file. */
	stdinFilename: string | undefined;
	quiet: boolean;
	help: boolean;
	version: boolean;
	/** Run as an MCP server on standard input and output. */
	mcp: boolean;
	/** Ask Jev about the questions after linting them. The only thing that sends anything. */
	jev: boolean;
	/** Say what `jev` would send, and send nothing. */
	jevPlan: boolean;
	jevModel: string | undefined;
	/** The most requests in the whole run. */
	jevMaxCalls: number | undefined;
	jevSendState: boolean;
}>;

export type Parsed =
	| Readonly<{ ok: true; options: CliOptions }>
	| Readonly<{ ok: false; error: string }>;

type Applied = CliOptions | string;

type Flag = Readonly<{
	name: string;
	/** The placeholder shown in the help. A flag without one takes no value. */
	value?: string;
	help: string;
	apply: (options: CliOptions, value: string) => Applied;
}>;

const FORMATS: ReadonlyArray<string> = ['text', 'json', 'github'];

// The help is printed from this table, so a flag cannot exist without its line.
const FLAGS: ReadonlyArray<Flag> = Object.freeze([
	{
		name: '--format',
		value: 'text|json|github',
		help: 'How findings are printed. github writes workflow annotations.',
		apply: (options, value) =>
			FORMATS.includes(value)
				? { ...options, format: value as Format }
				: `'${value}' is not a format. Use one of ${FORMATS.join(', ')}.`,
	},
	{
		name: '--rule',
		value: 'CODE=level',
		help: `Set one rule's level: ${LEVELS.join(', ')}. May be repeated.`,
		apply: (options, value) => {
			const rule = readRule(value);
			if (typeof rule === 'string') return rule;
			return { ...options, rules: { ...options.rules, [rule[0]]: rule[1] } };
		},
	},
	{
		name: '--config',
		value: 'file',
		help: 'Use this settings file, and no jevlint-le.json found near the files.',
		apply: (options, value) => ({ ...options, config: value }),
	},
	{
		name: '--max-warnings',
		value: 'n',
		help: 'Fail when more than n warnings are reported. Errors always fail.',
		apply: (options, value) =>
			/^\d+$/.test(value)
				? { ...options, maxWarnings: Number(value) }
				: `'${value}' is not a whole number.`,
	},
	{
		name: '--stdin-filename',
		value: 'path',
		help: 'Lint the text on standard input as if it were this file.',
		apply: (options, value) => ({ ...options, stdinFilename: value }),
	},
	{
		name: '--quiet',
		help: 'Print errors only. Jev findings are warnings or less unless --rule raises one.',
		apply: (options) => ({ ...options, quiet: true }),
	},
	{
		name: '--jev',
		help: `Also ask Jev about each question. Sends them to TypeSafe with the key in ${ENV_KEY}.`,
		apply: (options) => ({ ...options, jev: true }),
	},
	{
		name: '--jev-plan',
		help: 'Say what --jev would send, and send nothing. Needs no key.',
		apply: (options) => ({ ...options, jevPlan: true }),
	},
	{
		name: '--jev-model',
		value: 'id',
		help: `The model --jev asks. Default ${DEFAULT_MODEL}, which the checks were measured on.`,
		apply: (options, value) =>
			value.trim()
				? { ...options, jevModel: value.trim() }
				: 'a model id is needed.',
	},
	{
		name: '--jev-max-calls',
		value: 'n',
		help: `The most requests --jev may send in the run. Default ${DEFAULT_MAX_CALLS}. The run fails if more are needed.`,
		apply: (options, value) =>
			/^[1-9]\d*$/.test(value)
				? { ...options, jevMaxCalls: Number(value) }
				: `'${value}' is not a whole number above zero.`,
	},
	{
		name: '--jev-send-state',
		help: 'With --jev, also send state that is written out in a file.',
		apply: (options) => ({ ...options, jevSendState: true }),
	},
	{
		name: '--mcp',
		help: 'Run as an MCP server on standard input and output, for AI agents.',
		apply: (options) => ({ ...options, mcp: true }),
	},
	{
		name: '--help',
		help: 'Print this and exit.',
		apply: (options) => ({ ...options, help: true }),
	},
	{
		name: '--version',
		help: 'Print the version and exit.',
		apply: (options) => ({ ...options, version: true }),
	},
]);

export const FLAG_NAMES: ReadonlyArray<string> = FLAGS.map((flag) => flag.name);

const DEFAULTS: CliOptions = Object.freeze({
	paths: [],
	format: 'text',
	rules: {},
	config: undefined,
	maxWarnings: undefined,
	stdinFilename: undefined,
	quiet: false,
	help: false,
	version: false,
	mcp: false,
	jev: false,
	jevPlan: false,
	jevModel: undefined,
	jevMaxCalls: undefined,
	jevSendState: false,
});

export function helpText(): string {
	const usage = FLAGS.map((flag) =>
		flag.value ? `${flag.name} <${flag.value}>` : flag.name,
	);
	const width = Math.max(...usage.map((entry) => entry.length));
	return [
		'Usage: jevlint-le [options] [file or directory ...]',
		'',
		'Lints the questions written for the Jev model. With no path it lints the',
		'current directory. It sends nothing over the network unless --jev is given.',
		'',
		...FLAGS.map(
			(flag, i) => `  ${(usage[i] ?? '').padEnd(width)}  ${flag.help}`,
		),
		'',
		'Exit status: 0 when the run passes, 1 when a finding fails it, 2 when the',
		'run could not be done as asked.',
		'',
	].join('\n');
}

/** Reads the arguments after the program name. An unknown flag is an error, never a path. */
export function parseArgs(argv: ReadonlyArray<string>): Parsed {
	let options = DEFAULTS;
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i] as string;
		i += 1;
		if (!arg.startsWith('--')) {
			options = { ...options, paths: [...options.paths, arg] };
			continue;
		}
		const [name = '', inline] = arg.split(/=(.*)/s);
		const flag = FLAGS.find((candidate) => candidate.name === name);
		if (!flag) return { ok: false, error: `Unknown option '${name}'.` };
		const takesNext = flag.value !== undefined && inline === undefined;
		const value = takesNext ? argv[i] : inline;
		if (takesNext) i += 1;
		if (flag.value !== undefined && value === undefined)
			return { ok: false, error: `${name} needs a value: <${flag.value}>.` };
		if (flag.value === undefined && inline !== undefined)
			return { ok: false, error: `${name} takes no value.` };
		const applied = flag.apply(options, value ?? '');
		if (typeof applied === 'string')
			return { ok: false, error: `${name}: ${applied}` };
		options = applied;
	}
	return { ok: true, options };
}
