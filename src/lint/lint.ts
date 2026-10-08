import { readEmbedded } from '../extraction/embedded';
import { findFunctions } from '../extraction/functions';
import { readGoNodes } from '../extraction/goReader';
import { tokenizeGo } from '../extraction/goTokens';
import { readPythonNodes } from '../extraction/pythonReader';
import { tokenizePython } from '../extraction/pythonTokens';
import { HELPERS, readNodes } from '../extraction/reader';
import { extract } from '../extraction/requests';
import { readRustNodes } from '../extraction/rustReader';
import { tokenizeRust } from '../extraction/rustTokens';
import { type Token, tokenize } from '../extraction/tokens';
import { expandCalls, findWrappers } from '../extraction/wrappers';
import type {
	Extraction,
	Finding,
	LintOptions,
	LintResult,
	Node,
	ReportedFinding,
	Span,
	Syntax,
} from '../types';
import { check } from './checks';
import { normalizeOption } from './finding';
import { RULES } from './rules';
import { suppression, type UnusedDirective } from './suppress';

/**
 * An option counts as a fallback when one of these is a word in its name, so
 * `none_implied`, `other_or_unclear` and `uncertain_value` all count. The last
 * six are "other" in the languages public sample 3 was written in besides
 * English.
 */
export const DEFAULT_FALLBACK_OPTIONS: ReadonlyArray<string> = Object.freeze([
	'other',
	'none',
	'none of the above',
	'unknown',
	'unclear',
	'uncertain',
	'unsure',
	'ambiguous',
	'undetermined',
	'neither',
	'not stated',
	'not applicable',
	'insufficient evidence',
	'cannot tell',
	'n/a',
	'その他',
	'其他',
	'otro',
	'outro',
	'autre',
	'andere',
]);

export const DEFAULT_OPTIONS: LintOptions = Object.freeze({
	rules: Object.freeze({}),
	fallbackOptions: DEFAULT_FALLBACK_OPTIONS,
	ignore: Object.freeze([]),
});

const EMPTY: LintResult = Object.freeze({
	findings: Object.freeze([]),
	questionCount: 0,
	unreadableCount: 0,
});

// A file with none of these words cannot hold a question, and most files a
// user opens hold none. This keeps the cost of the common case at one scan.
const TRIGGERS: Readonly<Record<Syntax, RegExp>> = Object.freeze({
	js: /\b(?:noul|choice|score|predicate)\b|jev-|jev\/ask|gpt-6-luna|\/v1\/decisions/,
	python:
		/\b(?:noul|choice|score|predicate)\b|jev-|typesafe_|gpt-6-luna|decisions\.create/i,
	rust: /noul|choice|score|predicate|jev-|gpt-6-luna/i,
	go: /noul|choice|score|predicate|jev-|gpt-6-luna/i,
});
// A request whose only question has its type misspelt holds none of the
// words above. It still says `questions` and `instructions`, and few other
// files say both.
const namesQuestions = (text: string): boolean =>
	/\bquestions\b/.test(text) && /\binstructions\b/.test(text);

// `import { choice as pick }` binds `pick`, which the reader does not follow,
// so only helpers imported under their own names are read.
const SDK_IMPORT =
	/\{([^}]*)\}\s*(?:from\s*|=\s*(?:await\s+)?(?:require|import)\s*\(\s*)['"]@typesafe-ai\/sdk['"]/g;

/** The SDK helpers this file imports by name. */
function importedHelpers(text: string): ReadonlySet<string> {
	const names = [...text.matchAll(SDK_IMPORT)].flatMap((match) =>
		(match[1] ?? '')
			.split(',')
			.map((name) => name.trim())
			.filter((name) => HELPERS.has(name)),
	);
	return new Set(names);
}

/** Larger files are not read, in the editor or on the command line. */
export const MAX_FILE_SIZE_BYTES = 1_000_000;

/**
 * Every file extension the tool reads and the reader it needs. The editor's
 * `include` setting and the command line's directory search both come from
 * this, and `cli.test.ts` holds the setting to it.
 */
export const EXTENSIONS: Readonly<Record<string, Syntax>> = Object.freeze({
	json: 'js',
	jsonc: 'js',
	js: 'js',
	jsx: 'js',
	mjs: 'js',
	cjs: 'js',
	ts: 'js',
	tsx: 'js',
	mts: 'js',
	cts: 'js',
	py: 'python',
	rs: 'rust',
	go: 'go',
});

/** The reader for a file path, or undefined when the tool does not read that type. */
export function syntaxForPath(path: string): Syntax | undefined {
	const dot = path.lastIndexOf('.');
	return dot === -1 ? undefined : EXTENSIONS[path.slice(dot + 1).toLowerCase()];
}

const NO_HELPERS: ReadonlySet<string> = new Set();

type Language = Readonly<{
	tokenize: (text: string) => ReadonlyArray<Token>;
	read: (
		text: string,
		tokens: ReadonlyArray<Token>,
		calls?: ReadonlySet<string>,
	) => ReadonlyArray<Node>;
}>;

// A new language is an entry here, an extension in `EXTENSIONS` and nothing else.
const LANGUAGES: Readonly<Record<Syntax, Language>> = Object.freeze({
	js: { tokenize, read: readNodes },
	python: { tokenize: tokenizePython, read: readPythonNodes },
	rust: { tokenize: tokenizeRust, read: readRustNodes },
	go: { tokenize: tokenizeGo, read: readGoNodes },
});

const LANGUAGE_IDS: Readonly<Record<string, Syntax>> = Object.freeze({
	python: 'python',
	rust: 'rust',
	go: 'go',
});

/** The reader for an editor language id. Anything not listed is read as JavaScript, which covers JSON. */
export function syntaxFor(languageId: string): Syntax {
	return LANGUAGE_IDS[languageId] ?? 'js';
}

// A question defined under a name and used in a request is reached twice: at
// its definition and through the name. The use in a request says more.
function once(extraction: Extraction): Extraction {
	const inMap = new Set(
		extraction.questions
			.filter((question) => question.map !== undefined)
			.map((question) => question.span.start),
	);
	const seen = new Set<number>();
	const questions = extraction.questions.filter((question) => {
		const at = question.span.start;
		if (question.map !== undefined) return true;
		const repeat = inMap.has(at) || seen.has(at);
		seen.add(at);
		return !repeat;
	});
	return { ...extraction, questions };
}

type Read = Readonly<{ extraction: Extraction; embedded: ReadonlyArray<Span> }>;

function read(text: string, syntax: Syntax): Read {
	const language = LANGUAGES[syntax];
	const tokens = language.tokenize(text);
	const embedded = readEmbedded(text, tokens);
	// Only JavaScript has helper functions to trust. The other readers settle
	// which calls are questions while they read.
	const trusted = syntax === 'js' ? importedHelpers(text) : NO_HELPERS;
	const first = extract(language.read(text, tokens), trusted);
	const wrappers = findWrappers(
		text,
		findFunctions(tokens, syntax),
		first.questions,
	);
	// A second reading, this time keeping the calls to the file's own wrappers,
	// each of which is turned into the question it builds.
	const called = wrappers.size
		? extract(
				expandCalls(
					language.read(text, tokens, new Set(wrappers.keys())),
					wrappers,
					text,
				),
				trusted,
			)
		: first;
	const templates = new Set(
		[...wrappers.values()].map((wrapper) => wrapper.template.span.start),
	);
	const own: Extraction = {
		...called,
		// A wrapper builds questions. It is not one.
		questions: called.questions.filter(
			(question) => !templates.has(question.span.start),
		),
	};
	const pasted = extract(embedded.nodes, NO_HELPERS);
	return {
		extraction: once({
			questions: [...own.questions, ...pasted.questions],
			maps: [...own.maps, ...pasted.maps],
			malformed: [...own.malformed, ...pasted.malformed],
			models: [...own.models, ...pasted.models],
		}),
		embedded: embedded.regions,
	};
}

/** The questions in a file, for callers that need the questions themselves and not findings. */
export function readQuestions(text: string, syntax: Syntax = 'js'): Extraction {
	return read(text, syntax).extraction;
}

function unusedDisable(unused: UnusedDirective): Finding {
	const named =
		'This comment silences nothing. Remove it, so it cannot hide a finding that is added later.';
	return {
		code: 'JEV010',
		message: unused.bare
			? `${named} If it is there for a check Jev makes, name the rule, such as JEV303.`
			: named,
		span: unused.span,
		questionId: undefined,
		fix: undefined,
	};
}

function isIgnored(finding: Finding, ignore: ReadonlyArray<string>): boolean {
	return (
		finding.questionId !== undefined &&
		ignore.includes(`${finding.code}:${finding.questionId}`)
	);
}

function withSeverity(
	finding: Finding,
	options: LintOptions,
): ReportedFinding | undefined {
	const severity = options.rules[finding.code] ?? RULES[finding.code].severity;
	if (severity === 'off') return undefined;
	return { ...finding, severity };
}

/**
 * Lints one file's text. Pure: no editor, no filesystem, no network. The
 * unreadable count is taken before any suppression, so silencing JEV000 can
 * hide the hints but cannot make an unread file look fully checked.
 */
export function lintText(
	text: string,
	options: LintOptions = DEFAULT_OPTIONS,
	syntax: Syntax = 'js',
): LintResult {
	// The library is called from untyped code, where a file extension is an easy thing to pass here.
	if (!(syntax in TRIGGERS)) {
		throw new Error(
			`Unknown syntax ${JSON.stringify(syntax)}. Use one of: ${Object.keys(TRIGGERS).join(', ')}.`,
		);
	}
	if (!TRIGGERS[syntax].test(text) && !namesQuestions(text)) return EMPTY;

	const { extraction, embedded } = read(text, syntax);
	// JSON inside a string is edited as JSON, whatever the file around it is.
	const inside = (offset: number): boolean =>
		embedded.some((span) => span.start <= offset && offset < span.end);
	const syntaxAt = (offset: number): Syntax => (inside(offset) ? 'js' : syntax);
	const fallback = new Set(options.fallbackOptions.map(normalizeOption));
	const fallbackName = options.fallbackOptions[0] ?? 'other';
	const all = check(extraction, { text, fallback, fallbackName, syntaxAt });

	const comments = suppression(text);
	const seen = new Set<string>();
	// Rules that are off come out first: a comment for a rule that reports
	// nothing has silenced nothing.
	const reported = all
		.map((finding) => withSeverity(finding, options))
		.filter((finding): finding is ReportedFinding => finding !== undefined)
		.filter(
			(finding) =>
				!comments.isSuppressed(finding) && !isIgnored(finding, options.ignore),
		);
	// Asked for only now, when every finding has had its turn at the comments.
	const stale = comments
		.unused()
		.map((unused) => withSeverity(unusedDisable(unused), options));
	const findings = [...reported, ...stale]
		.map((finding) =>
			finding && inside(finding.span.start)
				? { ...finding, inString: true }
				: finding,
		)
		.filter((finding): finding is ReportedFinding => finding !== undefined)
		.sort((a, b) => a.span.start - b.span.start)
		// A literal used by two questions is one mistake, not two.
		.filter((finding) => {
			const key = `${finding.code}:${finding.span.start}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

	return Object.freeze({
		findings,
		questionCount: extraction.questions.length + extraction.malformed.length,
		unreadableCount: all.filter((finding) => finding.code === 'JEV000').length,
	});
}
