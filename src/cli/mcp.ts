import { readRules } from '../config/projectConfig';
import { rulePage } from '../docs/rulePages';
import { ask, isFailure } from '../jev/client';
import { toLiteral, toPlain } from '../jev/literal';
import {
	buildProbe,
	type ProbeResult,
	readProbe,
	summarize,
} from '../jev/probe';
import { providerFor } from '../jev/provider';
import { DEFAULT_MAX_CALLS, DEFAULT_MODEL } from '../jev/review';
import { fixText } from '../lint/fixAll';
import { readQuestions, syntaxForPath } from '../lint/lint';
import { pageFor, RULE_CODES, RULES } from '../lint/rules';
import type { RuleCode, Syntax } from '../types';
import { keyFrom, keyPlaces } from './dotenv';
import { type FileReport, type JevTotals, plural, toReport } from './format';
import { failureMessage, planJev, runJev } from './jev';
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
	annotations: Json;
	call: (input: Json, io: Io) => Outcome | Promise<Outcome>;
}>;

// These tools read, and none reaches past the files it is given: a host can
// let an agent call them without asking. fix_text returns text and writes nothing.
const READ_ONLY = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});
// These send the questions to the vendor with the user's key and cost money
// each time, so a host should ask before running them.
const SENDS = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
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
const PATHS_SCHEMA = Object.freeze({
	type: 'array',
	items: { type: 'string' },
	minItems: 1,
	description:
		'Files or directories on disk, relative to the directory the server was started in.',
});
const JEV_INPUTS = Object.freeze({
	model: {
		type: 'string',
		description: `The model to ask: a Jev version, or gpt-6-luna for OpenAI's Decisions API. Defaults to ${DEFAULT_MODEL}, which the checks were measured on.`,
	},
	maxCalls: {
		type: 'integer',
		minimum: 1,
		description: `The most requests the call may send. Defaults to ${DEFAULT_MAX_CALLS}. Requests past it are counted and not sent.`,
	},
	sendState: {
		type: 'boolean',
		description:
			'Also send the state written out in the text, to the checks that read it. Defaults to false.',
	},
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
const JEV_TOTALS_SCHEMA = Object.freeze({
	type: 'object',
	description:
		'What was sent to the model, or under plan_jev what would be. Present only on those calls.',
	properties: {
		sent: {
			type: 'boolean',
			description: 'False when the call only planned.',
		},
		planned: integer('Requests within the limit.'),
		answered: integer('Requests the model answered.'),
		runtime: integer(
			'Questions with a part built at runtime, which the model is never shown.',
		),
		overLimit: integer('Requests left out for being past maxCalls.'),
		estimatedInputTokens: integer('An estimate made before sending.'),
		inputTokens: integer('What the vendor counted.'),
		model: { type: 'string' },
		state: {
			type: 'boolean',
			description: 'True when state written in the text was sent, or would be.',
		},
	},
	required: [
		'sent',
		'planned',
		'answered',
		'runtime',
		'overLimit',
		'estimatedInputTokens',
		'inputTokens',
		'model',
		'state',
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
			jev: JEV_TOTALS_SCHEMA,
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
const KEY_SOURCE_SCHEMA = Object.freeze({
	type: 'string',
	description:
		'Where the API key was found: the environment, .env.local or .env. Never the key.',
});
const CHECKED_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		...REPORT_PROPERTIES,
		keySource: KEY_SOURCE_SCHEMA,
		shortfall: {
			type: ['string', 'null'],
			description:
				'Why the check covered less than it planned, or null when it covered everything: a failed request, a stop, or questions past maxCalls.',
		},
	},
	required: ['files', 'totals', 'keySource', 'shortfall'],
});
const PROBED_SCHEMA = Object.freeze({
	type: 'object',
	properties: {
		questionId: { type: 'string' },
		model: { type: 'string' },
		requests: integer(
			'Requests sent: three as written, then one per layout change.',
		),
		verdict: {
			type: 'string',
			description: 'The one sentence the report opens with.',
		},
		moved: {
			type: 'array',
			items: { type: 'string' },
			description:
				'The variants that changed the decision. Empty when the answer held.',
		},
		keySource: KEY_SOURCE_SCHEMA,
		markdown: { type: 'string', description: 'The full report, as Markdown.' },
	},
	required: [
		'questionId',
		'model',
		'requests',
		'verdict',
		'moved',
		'keySource',
		'markdown',
	],
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
			'False for a rule that asks the model itself, which only check_with_jev runs.',
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

const NOTHING_LEFT: Left = Object.freeze({ skipped: [], unread: [] });

type Picked = Readonly<{
	sources: ReadonlyArray<Source>;
	left: Left;
	/** True when the sources were found on disk, so a settings file may leave some out. */
	searched: boolean;
}>;

function pathsFrom(input: Json, io: Io): Picked | string {
	const { paths } = input;
	const listed =
		Array.isArray(paths) &&
		paths.length > 0 &&
		paths.every((path) => typeof path === 'string');
	if (!listed) return "'paths' must be a list of at least one path.";
	const gathered = gatherPaths(paths as string[], io.files);
	if (typeof gathered === 'string') return gathered;
	return { sources: gathered.sources, left: gathered.left, searched: true };
}

/** The text given, or the files under the paths given, for a tool that takes either. */
function picked(input: Json, io: Io): Picked | string {
	if (input.text !== undefined && input.paths !== undefined)
		return "Pass 'text' or 'paths', not both.";
	if (input.paths !== undefined) return pathsFrom(input, io);
	const given = named(input);
	if (typeof given === 'string') return given;
	return {
		sources: [{ path: given.filename, text: given.text }],
		left: NOTHING_LEFT,
		searched: false,
	};
}

type Linted = Readonly<{ reports: ReadonlyArray<FileReport>; left: Left }>;

function lint(pick: Picked, settings: Settings): Linted | string {
	// Text passed in was handed over on purpose. Only files found on disk can be left out.
	const kept = pick.searched
		? withoutExcluded(pick.sources, settings)
		: { sources: pick.sources, excluded: 0 };
	const linted = lintSources(kept.sources, settings.optionsFor, false);
	if (typeof linted === 'string') return linted;
	return {
		reports: linted.reports,
		left: {
			excluded: kept.excluded,
			skipped: pick.left.skipped,
			unread: [...pick.left.unread, ...linted.failed],
		},
	};
}

function report(pick: Picked, settings: Settings): Outcome {
	const linted = lint(pick, settings);
	if (typeof linted === 'string') return fail(linted);
	return ok(toReport(linted.reports, total(linted.reports, linted.left)));
}

function lintTextTool(input: Json, io: Io): Outcome {
	const given = named(input);
	if (typeof given === 'string') return fail(given);
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return fail(settings);
	return report(
		{
			sources: [{ path: given.filename, text: given.text }],
			left: NOTHING_LEFT,
			searched: false,
		},
		settings,
	);
}

function lintPathsTool(input: Json, io: Io): Outcome {
	const pick = pathsFrom(input, io);
	if (typeof pick === 'string') return fail(pick);
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return fail(settings);
	return report(pick, settings);
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
		{
			sources: [{ path: given.filename, text: mended.text }],
			left: NOTHING_LEFT,
			searched: false,
		},
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
		// These ask the model itself, which only check_with_jev does, with the user's key.
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

type JevAsked = Readonly<{
	model: string;
	maxCalls: number;
	sendState: boolean;
}>;

function jevAsked(input: Json): JevAsked | string {
	const {
		model = DEFAULT_MODEL,
		maxCalls = DEFAULT_MAX_CALLS,
		sendState = false,
	} = input;
	if (typeof model !== 'string' || !model.trim())
		return `'model' must be a model id, such as ${DEFAULT_MODEL} or gpt-6-luna.`;
	if (!Number.isInteger(maxCalls) || (maxCalls as number) < 1)
		return "'maxCalls' must be a whole number above zero.";
	if (typeof sendState !== 'boolean')
		return "'sendState' must be true or false.";
	return { model: model.trim(), maxCalls: maxCalls as number, sendState };
}

type Planned = Readonly<{
	linted: Linted;
	plan: ReturnType<typeof planJev>;
}>;

/** Everything check_with_jev and plan_jev share before anything is sent. */
function planned(input: Json, io: Io, asked: JevAsked): Planned | string {
	const settings = settingsFrom(input, io);
	if (typeof settings === 'string') return settings;
	const pick = picked(input, io);
	if (typeof pick === 'string') return pick;
	const linted = lint(pick, settings);
	if (typeof linted === 'string') return linted;
	const plan = planJev(linted.reports, settings.optionsFor, {
		jevModel: asked.model,
		jevMaxCalls: asked.maxCalls,
		jevSendState: asked.sendState,
	});
	if (typeof plan === 'string') return plan;
	return { linted, plan };
}

function planJevTool(input: Json, io: Io): Outcome {
	const asked = jevAsked(input);
	if (typeof asked === 'string') return fail(asked);
	const ready = planned(input, io, asked);
	if (typeof ready === 'string') return fail(ready);
	if (typeof ready.plan === 'string') return fail(ready.plan);
	const { reports, left } = ready.linted;
	return ok(
		toReport(reports, { ...total(reports, left), jev: ready.plan.totals }),
	);
}

// A check that covered part of what it was asked must not read as the whole.
function shortfall(
	jev: JevTotals,
	failure: string | undefined,
	stopped: boolean,
): string | undefined {
	const of = `${jev.answered} of ${plural(jev.planned, 'request')}`;
	if (failure) return `${failure}. Answered ${of}.`;
	if (stopped) return `Stopped. Answered ${of}.`;
	if (jev.overLimit)
		return `${plural(jev.overLimit, 'request')} over the maxCalls limit not sent. Raise maxCalls to check every question.`;
	return undefined;
}

async function checkWithJevTool(input: Json, io: Io): Promise<Outcome> {
	const asked = jevAsked(input);
	if (typeof asked === 'string') return fail(asked);
	const ready = planned(input, io, asked);
	if (typeof ready === 'string') return fail(ready);
	if (typeof ready.plan === 'string') return fail(ready.plan);
	const provider = providerFor(asked.model);
	// Looked for only once there is something to send, and never echoed.
	const found = keyFrom(provider.envKey, io.env, io.files);
	if (!found)
		return fail(
			`check_with_jev needs ${keyPlaces(provider.envKey)}. Nothing was sent.`,
		);
	const ran = await runJev(
		ready.plan,
		{
			fetch: io.fetch,
			wait: io.wait,
			key: found.key,
			signal: io.stopSignal(),
		},
		false,
	);
	const failure =
		ran.failure &&
		`${failureMessage(ran.failure.kind, provider)} (${ran.failure.detail})`;
	const short = shortfall(ran.totals, failure, ran.stopped);
	// Nothing answered and a reason why is a failed call. Part answered is a
	// result, with the reason it is only part.
	if (short && !ran.totals.answered) return fail(short);
	const totals = {
		...total(ran.reports, ready.linted.left),
		jev: ran.totals,
	};
	return ok({
		...toReport(ran.reports, totals),
		keySource: found.source,
		shortfall: short ?? null,
	});
}

async function probeQuestionTool(input: Json, io: Io): Promise<Outcome> {
	const given = named(input);
	if (typeof given === 'string') return fail(given);
	const { questionId, model = DEFAULT_MODEL } = input;
	if (questionId !== undefined && typeof questionId !== 'string')
		return fail("'questionId' must be a string.");
	if (typeof model !== 'string' || !model.trim())
		return fail(`'model' must be a Jev version, such as ${DEFAULT_MODEL}.`);
	// The variants are built and read in Jev's shape. Luna's reply for a Choice or a Score is not read yet.
	const provider = providerFor(model.trim());
	if (provider.id !== 'typesafe')
		return fail(
			`The probe asks Jev only. Use a Jev version, such as ${DEFAULT_MODEL}.`,
		);
	const extraction = readQuestions(given.text, given.syntax);
	const candidates =
		questionId === undefined
			? extraction.questions
			: extraction.questions.filter((question) => question.id === questionId);
	if (!candidates.length)
		return fail(
			questionId === undefined
				? 'No question was found in the text.'
				: `No question with the id '${questionId}' was found in the text.`,
		);
	if (candidates.length > 1) {
		const ids = candidates.map((question) => question.id ?? '(no id)');
		return fail(
			`The text has ${candidates.length} questions. Name one with 'questionId': ${ids.join(', ')}.`,
		);
	}
	const question = candidates[0] as (typeof candidates)[number];
	const literal = toLiteral(question);
	if (!literal)
		return fail(
			'Part of this question is built at runtime, so it cannot be sent as written.',
		);
	const map =
		question.map === undefined ? undefined : extraction.maps[question.map];
	const state = map?.state ? toPlain(map.state) : undefined;
	if (state === undefined)
		return fail(
			'A probe sends the question against its state, so it needs a request with the state written out in the text.',
		);
	const found = keyFrom(provider.envKey, io.env, io.files);
	if (!found)
		return fail(
			`probe_question needs ${keyPlaces(provider.envKey)}. Nothing was sent.`,
		);
	const variants = buildProbe(state, literal, model.trim());
	const signal = io.stopSignal();
	const results: ProbeResult[] = [];
	for (const variant of variants) {
		const reply = await ask(
			{ fetch: io.fetch, key: found.key, wait: io.wait, signal },
			variant.request,
		);
		// A report built from some of the variants would compare against repeats that never ran.
		if (isFailure(reply))
			return fail(
				`${failureMessage(reply.kind, provider)} (${reply.detail}). Answered ${results.length} of ${variants.length} requests, so no report was made, because part of one would mislead.`,
			);
		results.push({ variant, reading: readProbe(variant, reply.answers) });
	}
	const id = question.id ?? 'question';
	const probed = summarize(id, literal.type, results);
	return ok(
		{
			questionId: id,
			model: model.trim(),
			requests: results.length,
			verdict: probed.verdict,
			moved: probed.moved,
			keySource: found.source,
			markdown: probed.markdown,
		},
		probed.markdown,
	);
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
		annotations: READ_ONLY,
		call: lintTextTool,
	},
	{
		name: 'lint_paths',
		title: 'Lint files',
		description:
			'Lint the Jev and OpenAI Decisions questions in files or directories on disk. A directory is searched for the file types the linter reads. Returns the same report as lint_text, one entry per file. It sends nothing over the network.',
		inputSchema: {
			type: 'object',
			properties: { paths: PATHS_SCHEMA, rules: RULES_SCHEMA },
			required: ['paths'],
		},
		outputSchema: REPORT_SCHEMA,
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
		call: fixTextTool,
	},
	{
		name: 'list_rules',
		title: 'List rules',
		description:
			'List every rule with its code, name, what it catches, default level, its own page with an example, the vendor page behind it, and whether it runs offline here or only when check_with_jev asks the model.',
		inputSchema: { type: 'object', properties: {} },
		outputSchema: RULE_LIST_SCHEMA,
		annotations: READ_ONLY,
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
		annotations: READ_ONLY,
		call: (input) => explainRuleTool(input),
	},
	{
		name: 'plan_jev',
		title: 'Plan a check with the model',
		description:
			'Say what check_with_jev would send for the given text or paths, and send nothing: how many requests, to which model, about how many input tokens, how many questions are held back for having a part built at runtime, and how many fall past maxCalls. Needs no key. Call it first when the user wants to know the cost of a check before paying for it.',
		inputSchema: {
			type: 'object',
			properties: {
				text: TEXT_SCHEMA,
				filename: FILENAME_SCHEMA,
				paths: PATHS_SCHEMA,
				rules: RULES_SCHEMA,
				...JEV_INPUTS,
			},
		},
		outputSchema: REPORT_SCHEMA,
		annotations: READ_ONLY,
		call: planJevTool,
	},
	{
		name: 'check_with_jev',
		title: 'Check with the model',
		description:
			"Ask the model itself, TypeSafe's Jev or OpenAI's Luna, to check the questions in the given text or paths after linting them: overlapping options, a question that needs counting, a label that does not match its description, and the other checks list_rules marks runsHere: false. This sends the questions to the vendor with the user's own API key and costs money, so call it only when the user asks for a check with Jev or Luna, never on every edit, and use plan_jev first when the cost matters. The key is read from TYPESAFE_API_KEY or OPENAI_API_KEY in the environment the server was started with, or from .env.local or .env in its working directory, and is never taken as an argument. Returns the lint report with the model's findings added, each with the probability the model gave, what was sent and answered, and why the check fell short when it did. Bounded by maxCalls.",
		inputSchema: {
			type: 'object',
			properties: {
				text: TEXT_SCHEMA,
				filename: FILENAME_SCHEMA,
				paths: PATHS_SCHEMA,
				rules: RULES_SCHEMA,
				...JEV_INPUTS,
			},
		},
		outputSchema: CHECKED_SCHEMA,
		annotations: SENDS,
		call: checkWithJevTool,
	},
	{
		name: 'probe_question',
		title: 'Probe a question',
		description:
			"Send one question to Jev several times, as written and with its layout changed, options reversed, labels hidden, levels reversed, criteria removed, to see whether the answer holds. Returns a report as Markdown with a verdict and which variants moved the decision. The text must carry the state the question is asked against, and when it has more than one question, questionId names the one. Asks Jev only, about a dozen requests, with the user's TypeSafe key found the way check_with_jev finds it. It costs money, so call it only when the user asks to probe a question.",
		inputSchema: {
			type: 'object',
			properties: {
				text: TEXT_SCHEMA,
				filename: FILENAME_SCHEMA,
				questionId: {
					type: 'string',
					description:
						'The id of the question to probe. Needed when the text has more than one.',
				},
				model: {
					type: 'string',
					description: `A Jev version. Defaults to ${DEFAULT_MODEL}.`,
				},
			},
			required: ['text'],
		},
		outputSchema: PROBED_SCHEMA,
		annotations: SENDS,
		call: probeQuestionTool,
	},
]);

// What an agent reads once, before it has seen a tool: when to reach for this server.
const INSTRUCTIONS =
	"Lints questions written for a decision model, TypeSafe's Jev or OpenAI's Decisions API (gpt-6-luna), before they are sent. Call lint_text after writing or changing a question, in a request body or in code. Call fix_text for the mended text where the fix is certain, and explain_rule for a rule's page with an example before making the fixes it leaves to you. Those, lint_paths, list_rules and plan_jev send nothing and need no key. check_with_jev and probe_question send the questions to the vendor with the user's own API key and cost money: call them only when the user asks for a check with Jev or Luna, or for a probe. The server writes nothing.";

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
async function attempt(
	call: () => Outcome | Promise<Outcome>,
): Promise<Outcome> {
	try {
		return await call();
	} catch (error) {
		return fail(reason(error));
	}
}

async function callTool(params: Json, io: Io): Promise<Json> {
	const tool = TOOLS.find((candidate) => candidate.name === params.name);
	const input = (params.arguments ?? {}) as Json;
	const outcome = tool
		? await attempt(() => tool.call(input, io))
		: fail(`Unknown tool: ${String(params.name)}`);
	return {
		content: [{ type: 'text', text: outcome.text }],
		...(outcome.structured ? { structuredContent: outcome.structured } : {}),
		isError: outcome.failed,
	};
}

const METHODS: Readonly<
	Record<string, (params: Json, io: Io) => Json | Promise<Json>>
> = Object.freeze({
	initialize: (params, io) => initialize(params, io.version),
	ping: () => ({}),
	'tools/list': () => ({
		tools: TOOLS.map(
			({
				name,
				title,
				description,
				inputSchema,
				outputSchema,
				annotations,
			}) => ({
				name,
				title,
				description,
				inputSchema,
				outputSchema,
				annotations,
			}),
		),
	}),
	'tools/call': callTool,
});

const error = (id: unknown, code: number, message: string) =>
	JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

/** The reply to one line from the client, or undefined when the line needs none. */
export async function answer(
	line: string,
	io: Io,
): Promise<string | undefined> {
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
		const result = await handler(asked, io);
		return JSON.stringify({ jsonrpc: '2.0', id, result });
	} catch (thrown) {
		return error(id, ERRORS.internal, reason(thrown));
	}
}

/** Answers MCP requests, one JSON message per line, until the input closes. */
export async function serve(io: Io): Promise<void> {
	for await (const line of io.lines()) {
		if (!line.trim()) continue;
		const reply = await answer(line, io);
		if (reply !== undefined) io.out(`${reply}\n`);
	}
}
