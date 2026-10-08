import { readRules } from '../config/projectConfig';
import { syntaxForPath } from '../lint/lint';
import { pageFor, RULE_CODES, RULES } from '../lint/rules';
import { toReport } from './format';
import {
	createSettings,
	gatherPaths,
	type Io,
	type Left,
	lintSources,
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
type Outcome = Readonly<{ text: string; failed: boolean }>;
type Tool = Readonly<{
	name: string;
	description: string;
	inputSchema: Json;
	call: (input: Json, io: Io) => Outcome;
}>;

const RULES_SCHEMA = Object.freeze({
	type: 'object',
	description:
		'Rule levels to override, such as { "JEV004": "off" }. Levels: off, hint, info, warning, error.',
	additionalProperties: { type: 'string' },
});

const fail = (text: string): Outcome => ({ text, failed: true });

function report(
	sources: ReadonlyArray<Source>,
	left: Left,
	input: Json,
	io: Io,
	searched = false,
): Outcome {
	const rules = readRules(input.rules);
	if (typeof rules === 'string') return fail(rules);
	// The project's own settings file applies here as it does on the command line.
	const settings = createSettings(io.files, { rules });
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
	const text = JSON.stringify(toReport(linted.reports, totals), null, 2);
	return { text, failed: false };
}

function lintText(input: Json, io: Io): Outcome {
	const { text, filename = DEFAULT_NAME } = input;
	if (typeof text !== 'string') return fail("'text' must be a string.");
	if (typeof filename !== 'string') return fail("'filename' must be a string.");
	if (!syntaxForPath(filename))
		return fail(`Not a file type jevlint-le reads: ${filename}`);
	return report(
		[{ path: filename, text }],
		{ skipped: [], unread: [] },
		input,
		io,
	);
}

function lintPaths(input: Json, io: Io): Outcome {
	const { paths } = input;
	const listed =
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((path) => typeof path === 'string');
	if (!listed) return fail("'paths' must be a list of at least one path.");
	const gathered = gatherPaths(paths as string[], io.files);
	if (typeof gathered === 'string') return fail(gathered);
	return report(gathered.sources, gathered.left, input, io, true);
}

function listRules(): Outcome {
	const rules = RULE_CODES.map((code) => ({
		code,
		name: RULES[code].name,
		default: RULES[code].severity,
		docs: RULES[code].docs,
		page: pageFor(code),
		// These ask Jev itself, which this server never does.
		runsHere: !code.startsWith('JEV3'),
	}));
	return { text: JSON.stringify({ rules }, null, 2), failed: false };
}

const TOOLS: ReadonlyArray<Tool> = Object.freeze([
	{
		name: 'lint_text',
		description:
			"Lint questions written for a decision model before they are sent: TypeSafe's Jev (System One, /v1/systemone) and OpenAI's Decisions API (gpt-6-luna, /v1/decisions), in either request shape, or the Vercel AI SDK's decide() for both. Pass a request body as JSON, or source code that builds one. Returns each finding with its rule, message, position and docs link, plus how many questions were found and how many could not be read in full. Use it after writing or changing a question. It sends nothing over the network.",
		inputSchema: {
			type: 'object',
			properties: {
				text: {
					type: 'string',
					description: 'The request JSON or the source code.',
				},
				filename: {
					type: 'string',
					description: `A file name whose extension says what the text is: .json, .ts, .js, .py, .rs or .go. Defaults to ${DEFAULT_NAME}.`,
				},
				rules: RULES_SCHEMA,
			},
			required: ['text'],
		},
		call: lintText,
	},
	{
		name: 'lint_paths',
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
		call: lintPaths,
	},
	{
		name: 'list_rules',
		description:
			'List every rule with its code, name, default level, its own page with an example, and the vendor page behind it.',
		inputSchema: { type: 'object', properties: {} },
		call: () => listRules(),
	},
]);

// What an agent reads once, before it has seen a tool: when to reach for this server.
const INSTRUCTIONS =
	"Lints questions written for a decision model, TypeSafe's Jev or OpenAI's Decisions API (gpt-6-luna), before they are sent. Call lint_text after writing or changing a question, in a request body or in code, and fix what it reports. It never calls either model.";

function initialize(params: Json, version: string): Json {
	const asked = String(params.protocolVersion ?? '');
	return {
		protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
		capabilities: { tools: {} },
		serverInfo: { name: NAME, version },
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
		isError: outcome.failed,
	};
}

const METHODS: Readonly<Record<string, (params: Json, io: Io) => Json>> =
	Object.freeze({
		initialize: (params, io) => initialize(params, io.version),
		ping: () => ({}),
		'tools/list': () => ({
			tools: TOOLS.map(({ name, description, inputSchema }) => ({
				name,
				description,
				inputSchema,
			})),
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
