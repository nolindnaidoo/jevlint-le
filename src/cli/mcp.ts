import { readRules } from '../config/projectConfig';
import { rulePage } from '../docs/rulePages';
import { fixText } from '../lint/fixAll';
import { syntaxForPath } from '../lint/lint';
import { pageFor, RULE_CODES, RULES } from '../lint/rules';
import type { RuleCode, Syntax } from '../types';
import { toReport } from './format';
import {
	createSettings,
	gatherPaths,
	type Io,
	type Left,
	lintSources,
	type Settings,
	type Source,
	total,
	withoutExcluded,
} from './run';

const NAME = 'jevlint-le';
// Newest first. A client is answered in the version it asked for when it is one of these.
const PROTOCOLS: ReadonlyArray<string> = [
	'2025-06-18',
	'2025-03-26',
	'2024-11-05',
];
const ERRORS = Object.freeze({
	parse: -32700,
	request: -32600,
	method: -32601,
	internal: -32603,
});
const DEFAULT_NAME = 'request.jev.json';

type Json = Readonly<Record<string, unknown>>;
type Outcome = Readonly<{
	text: string;
	failed: boolean;
	/** The answer as data, for a client that reads `structuredContent`. */
	structured?: Json;
}>;
type Tool = Readonly<{
	name: string;
	title: string;
	description: string;
	inputSchema: Json;
	outputSchema: Json;
	call: (input: Json, io: Io) => Outcome;
}>;

// Every tool reads, and none reaches past the files it is given: a host can
// let an agent call them without asking. fix_text returns text and writes nothing.
const READ_ONLY = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

const RULES_SCHEMA = Object.freeze({
	type: 'object',
	description:
		'Rule levels to override, such as { "JEV004": "off" }. Levels: off, hint, info, warning, error.',
	additionalProperties: { type: 'string' },
});
const TEXT_SCHEMA = Object.freeze({
	type: 'string',
	description: 'The request JSON or the source code.',
});
const FILENAME_SCHEMA = Object.freeze({
	type: 'string',
	description: `A file name whose extension says what the text is: .json, .ts, .js, .py, .rs or .go. Defaults to ${DEFAULT_NAME}.`,
});

const integer = (description: string) =>
	Object.freeze({ type: 'integer', description });
const POSITION = Object.freeze({
	line: integer('One-based line where it starts.'),
	column: integer('One-based column where it starts.'),
	endLine: integer('One-based line where it ends.'),
	endColumn: integer('One-based column just past where it ends.'),
});
const FINDING_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		code: { type: 'string', description: 'The rule, such as JEV004.' },
		rule: { type: 'string', description: "The rule's name." },
		severity: { type: 'string', enum: ['hint', 'info', 'warning', 'error'] },
		message: { type: 'string' },
		questionId: {
			type: ['string', 'null'],
			description: 'The question the finding is about, when it has an id.',
		},
		...POSITION,
		docs: { type: 'string', description: 'The vendor page behind the rule.' },
		page: { type: 'string', description: "The rule's own page." },
		fix: {
			type: ['object', 'null'],
			description:
				'The edit the linter would make, or null when the change is yours to make. Safe when it only mends what the API would refuse, so fix_text applies it unasked. Otherwise it changes what a working request does, and is left to you.',
			properties: {
				title: { type: 'string' },
				safe: { type: 'boolean' },
				edits: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							...POSITION,
							text: {
								type: 'string',
								description: 'What replaces the text between the positions.',
							},
						},
						required: ['line', 'column', 'endLine', 'endColumn', 'text'],
					},
				},
			},
			required: ['title', 'safe', 'edits'],
		},
	},
	required: [
		'code',
		'rule',
		'severity',
		'message',
		'questionId',
		'line',
		'column',
		'endLine',
		'endColumn',
		'docs',
		'page',
		'fix',
	],
});
const REPORT_PROPERTIES = Object.freeze({
	files: {
		type: 'array',
		items: {
			type: 'object',
			properties: {
				path: { type: 'string' },
				questionCount: integer('Questions found in the file.'),
				unreadableCount: integer(
					'Questions with a part built at runtime, which no rule could read in full.',
				),
				findings: { type: 'array', items: FINDING_SCHEMA },
			},
			required: ['path', 'questionCount', 'unreadableCount', 'findings'],
		},
	},
	totals: {
		type: 'object',
		properties: {
			files: integer('Files linted.'),
			questions: integer('Questions found.'),
			unreadable: integer('Questions not read in full.'),
			excluded: integer('Files a settings file leaves out.'),
			skipped: {
				type: 'array',
				items: { type: 'string' },
				description: 'Files over the size limit, not read.',
			},
			unread: {
				type: 'array',
				items: { type: 'string' },
				description: 'Folders and files that could not be read.',
			},
			counts: {
				type: 'object',
				properties: {
					error: integer('Findings at error.'),
					warning: integer('Findings at warning.'),
					info: integer('Findings at info.'),
					hint: integer('Findings at hint.'),
				},
				required: ['error', 'warning', 'info', 'hint'],
			},
			fixable: integer('Findings fix_text would mend.'),
		},
		required: [
			'files',
			'questions',
			'unreadable',
			'excluded',
			'skipped',
			'unread',
			'counts',
			'fixable',
		],
	},
});
const REPORT_SCHEMA = Object.freeze({
	type: 'object',
	properties: REPORT_PROPERTIES,
	required: ['files', 'totals'],
});
const FIXED_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		text: {
			type: 'string',
			description: 'The text with the safe fixes applied.',
		},
		fixed: integer('Findings mended.'),
		...REPORT_PROPERTIES,
	},
	required: ['text', 'fixed', 'files', 'totals'],
});
const RULE_PROPERTIES = Object.freeze({
	code: { type: 'string' },
	name: { type: 'string' },
	meaning: {
		type: 'string',
		description: 'What the rule catches, in one sentence.',
	},
	default: {
		type: 'string',
		enum: ['off', 'hint', 'info', 'warning', 'error'],
		description: 'The level the rule runs at unless a setting changes it.',
	},
	docs: { type: 'string', description: 'The vendor page behind the rule.' },
	page: { type: 'string', description: "The rule's own page." },
	runsHere: {
		type: 'boolean',
		description:
			'False for a rule that asks Jev itself, which this server never does.',
	},
});
const RULE_LIST_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		rules: {
			type: 'array',
			items: {
				type: 'object',
				properties: RULE_PROPERTIES,
				required: Object.keys(RULE_PROPERTIES),
			},
		},
	},
	required: ['rules'],
});
const RULE_PAGE_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		...RULE_PROPERTIES,
		markdown: { type: 'string', description: "The rule's page, as Markdown." },
	},
	required: [...Object.keys(RULE_PROPERTIES), 'markdown'],
});

const fail = (text: string): Outcome => ({ text, failed: true });
const ok = (
	structured: Json,
	text = JSON.stringify(structured, null, 2),
): Outcome => ({ text, failed: false, structured });

/** The rule levels asked for, over the project's own settings file, which applies here as on the command line. */
function settingsFrom(input: Json, io: Io): Settings | string {
	const rules = readRules(input.rules);
	if (typeof rules === 'string') return rules;
	return createSettings(io.files, { rules });
}

type Named = Readonly<{ text: string; filename: string; syntax: Syntax }>;

function named(input: Json): Named | string {
	const { text, filename = DEFAULT_NAME } = input;
	if (typeof text !== 'string') return "'text' must be a string.";
	if (typeof filename !== 'string') return "'filename' must be a string.";
	const syntax = syntaxForPath(filename);
	if (!syntax) return `Not a file type jevlint-le reads: ${filename}`;
	return { text, filename, syntax };
}

function report(
	sources: ReadonlyArray<Source>,
	left: Left,
	settings: Settings,
	searched = false,
): Outcome {
	// Text passed in was handed over on purpose. Only files found on disk can be left out.
	const kept = searched
		? withoutExcluded(sources, settings)
		: { sources, excluded: 0 };
	const linted = lintSources(kept.sources, settings.optionsFor, false);
	if (typeof linted === 'string') return fail(linted);
	const totals = total(linted.reports, {
		excluded: kept.excluded,
		skipped: left.skipped,
		unread: [...left.unread, ...linted.failed],
	});
	return ok(toReport(linted.reports, totals));
}

const NOTHING_LEFT: Left = Object.freeze({ skipped: [], unread: [] });

function lintTextTool(input: Json, io: Io): Outcome {
	const given = named(input);
	if (typeof given === 'string') return fail(given);
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return fail(settings);
	return report(
		[{ path: given.filename, text: given.text }],
		NOTHING_LEFT,
		settings,
	);
}

function lintPathsTool(input: Json, io: Io): Outcome {
	const { paths } = input;
	const listed =
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((path) => typeof path === 'string');
	if (!listed) return fail("'paths' must be a list of at least one path.");
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return fail(settings);
	const gathered = gatherPaths(paths as string[], io.files);
	if (typeof gathered === 'string') return fail(gathered);
	return report(gathered.sources, gathered.left, settings, true);
}

// The mended text, and the report of what is left in it: the findings whose
// fix is the author's call, and those with no fix at all.
function fixTextTool(input: Json, io: Io): Outcome {
	const given = named(input);
	if (typeof given === 'string') return fail(given);
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return fail(settings);
	const options = settings.optionsFor(given.filename);
	if (typeof options === 'string') return fail(options);
	const mended = fixText(given.text, options, given.syntax);
	const left = report(
		[{ path: given.filename, text: mended.text }],
		NOTHING_LEFT,
		settings,
	);
	if (left.failed) return left;
	return ok({ text: mended.text, fixed: mended.fixed, ...left.structured });
}

const runsHere = (code: RuleCode) => !code.startsWith('JEV3');

function describe(code: RuleCode): Json {
	return {
		code,
		name: RULES[code].name,
		meaning: RULES[code].meaning,
		default: RULES[code].severity,
		docs: RULES[code].docs,
		page: pageFor(code),
		// These ask Jev itself, which this server never does.
		runsHere: runsHere(code),
	};
}

function listRulesTool(): Outcome {
	return ok({ rules: RULE_CODES.map(describe) });
}

function explainRuleTool(input: Json): Outcome {
	const { code } = input;
	if (typeof code !== 'string') return fail("'code' must be a string.");
	const asked = code.trim().toUpperCase();
	const known = RULE_CODES.find((candidate) => candidate === asked);
	if (!known)
		return fail(`Unknown rule: ${code}. list_rules names every rule.`);
	const markdown = rulePage(known);
	return ok({ ...describe(known), markdown }, markdown);
}

const TOOLS: ReadonlyArray<Tool> = Object.freeze([
	{
		name: 'lint_text',
		title: 'Lint text',
		description:
			"Lint questions written for a decision model before they are sent: TypeSafe's Jev (System One, /v1/systemone) and OpenAI's Decisions API (gpt-6-luna, /v1/decisions), in either request shape, or the Vercel AI SDK's decide() for both. Pass a request body as JSON, or source code that builds one. Returns each finding with its rule, message, position and docs link, the edit that would mend it when there is one, plus how many questions were found and how many could not be read in full. Use it after writing or changing a question. It sends nothing over the network.",
		inputSchema: {
			type: 'object',
			properties: {
				text: TEXT_SCHEMA,
				filename: FILENAME_SCHEMA,
				rules: RULES_SCHEMA,
			},
			required: ['text'],
		},
		outputSchema: REPORT_SCHEMA,
		call: lintTextTool,
	},
	{
		name: 'lint_paths',
		title: 'Lint files',
		description:
			'Lint the Jev and OpenAI Decisions questions in files or directories on disk. A directory is searched for the file types the linter reads. Returns the same report as lint_text, one entry per file.',
		inputSchema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
				rules: RULES_SCHEMA,
			},
			required: ['paths'],
		},
		outputSchema: REPORT_SCHEMA,
		call: lintPathsTool,
	},
	{
		name: 'fix_text',
		title: 'Fix text',
		description:
			'Apply the safe fixes to a request body or source code passed as text, and return the mended text with how many findings were mended and the report of what is left. A safe fix only mends what the API would refuse: a criteria key written yes where it takes true, a mistyped question type, criteria in the wrong shape. A fix that changes what a working request does, such as adding a fallback option or pinning a model, is never applied here. It stays in the report with its edit marked safe: false, for you to make or to leave. Nothing is written to disk and nothing is sent over the network.',
		inputSchema: {
			type: 'object',
			properties: {
				text: TEXT_SCHEMA,
				filename: FILENAME_SCHEMA,
				rules: RULES_SCHEMA,
			},
			required: ['text'],
		},
		outputSchema: FIXED_SCHEMA,
		call: fixTextTool,
	},
	{
		name: 'list_rules',
		title: 'List rules',
		description:
			'List every rule with its code, name, what it catches, default level, its own page with an example, the vendor page behind it, and whether it runs here.',
		inputSchema: { type: 'object', properties: {} },
		outputSchema: RULE_LIST_SCHEMA,
		call: () => listRulesTool(),
	},
	{
		name: 'explain_rule',
		title: 'Explain a rule',
		description:
			"A rule's own page, as Markdown: what it catches, an example that is flagged with the message the linter gives, one that is not, how to fix it and how to silence it. Use it before making a fix that fix_text leaves to you, or before silencing a finding.",
		inputSchema: {
			type: 'object',
			properties: {
				code: { type: 'string', description: 'The rule, such as JEV004.' },
			},
			required: ['code'],
		},
		outputSchema: RULE_PAGE_SCHEMA,
		call: (input) => explainRuleTool(input),
	},
]);

// What an agent reads once, before it has seen a tool: when to reach for this server.
const INSTRUCTIONS =
	"Lints questions written for a decision model, TypeSafe's Jev or OpenAI's Decisions API (gpt-6-luna), before they are sent. Call lint_text after writing or changing a question, in a request body or in code. Call fix_text for the mended text where the fix is certain, and explain_rule for a rule's page with an example before making the fixes it leaves to you. It never calls either model, and it writes nothing.";

function initialize(params: Json, version: string): Json {
	const asked = String(params.protocolVersion ?? '');
	return {
		protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
		capabilities: { tools: {} },
		serverInfo: { name: NAME, title: 'JevLint-LE', version },
		instructions: INSTRUCTIONS,
	};
}

const reason = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// A tool that throws, on a folder it may not list or a file that vanished, is
// a failed call. Left uncaught it ends the server, and the agent loses every tool.
function attempt(call: () => Outcome): Outcome {
	try {
		return call();
	} catch (error) {
		return fail(reason(error));
	}
}

function callTool(params: Json, io: Io): Json {
	const tool = TOOLS.find((candidate) => candidate.name === params.name);
	const input = (params.arguments ?? {}) as Json;
	const outcome = tool
		? attempt(() => tool.call(input, io))
		: fail(`Unknown tool: ${String(params.name)}`);
	return {
		content: [{ type: 'text', text: outcome.text }],
		...(outcome.structured ? { structuredContent: outcome.structured } : {}),
		isError: outcome.failed,
	};
}

const METHODS: Readonly<Record<string, (params: Json, io: Io) => Json>> =
	Object.freeze({
		initialize: (params, io) => initialize(params, io.version),
		ping: () => ({}),
		'tools/list': () => ({
			tools: TOOLS.map(
				({ name, title, description, inputSchema, outputSchema }) => ({
					name,
					title,
					description,
					inputSchema,
					outputSchema,
					annotations: READ_ONLY,
				}),
			),
		}),
		'tools/call': callTool,
	});

const error = (id: unknown, code: number, message: string) =>
	JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

/** The reply to one line from the client, or undefined when the line needs none. */
export function answer(line: string, io: Io): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return error(null, ERRORS.parse, 'Invalid JSON');
	}
	// Valid JSON that is not an object, such as `null` or a list, is not a request.
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		return error(null, ERRORS.request, 'Not a request');
	const { id, method, params } = parsed as Json;
	if (typeof method !== 'string')
		return error(id ?? null, ERRORS.request, 'Not a request');
	// A message with no id is a notification, which is never answered.
	if (id === undefined) return undefined;
	const handler = METHODS[method];
	if (!handler) return error(id, ERRORS.method, `Unknown method: ${method}`);
	const asked =
		typeof params === 'object' && params !== null ? (params as Json) : {};
	try {
		return JSON.stringify({ jsonrpc: '2.0', id, result: handler(asked, io) });
	} catch (thrown) {
		return error(id, ERRORS.internal, reason(thrown));
	}
}

/** Answers MCP requests, one JSON message per line, until the input closes. */
export async function serve(io: Io): Promise<void> {
	for await (const line of io.lines()) {
		if (!line.trim()) continue;
		const reply = answer(line, io);
		if (reply !== undefined) io.out(`${reply}\n`);
	}
}
