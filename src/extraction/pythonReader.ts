import type {
	ArrayNode,
	Node,
	ObjectNode,
	Prop,
	QuestionType,
	Span,
	UnreadableNode,
} from '../types';
import { createResolver, endsStatement, type Resolver } from './bindings';
import { isPunct, skipBalanced, skipExpression, spanOf } from './cursor';
import { tokenizePython } from './pythonTokens';
import { fillBraces, readJoined, slotted } from './slots';
import type { Token } from './tokens';

type Parsed<T extends Node = Node> = Readonly<{ node: T; next: number }>;

/** The names a file binds to the SDK, which is what makes a call a question. */
type Names = Readonly<{
	/** Local name to question type: `Noul`, or `N` after `import Noul as N`. */
	classes: ReadonlyMap<string, QuestionType>;
	/** Names the SDK module is imported under, for `typesafe_sdk.Noul(...)`. */
	modules: ReadonlySet<string>;
}>;

type Source = Readonly<{
	text: string;
	tokens: ReadonlyArray<Token>;
	names: Names;
	resolver: Resolver;
	/** Names of this file's own functions whose calls are to be read. */
	calls: ReadonlySet<string>;
}>;

const CLASS_TYPES: Readonly<Record<string, QuestionType>> = Object.freeze({
	Noul: 'noul',
	Choice: 'choice',
	Score: 'score',
});
const REQUEST_METHOD = 'system_one';
// `system_one(state, questions, *, model=...)`: the two it takes by position.
const REQUEST_POSITIONS: ReadonlyArray<string> = ['state', 'questions'];
const DECLARATORS = new Set(['def', 'class']);
const KEYWORD_LITERALS: Readonly<Record<string, (span: Span) => Node>> =
	Object.freeze({
		True: (span: Span): Node => ({ kind: 'boolean', value: true, span }),
		False: (span: Span): Node => ({ kind: 'boolean', value: false, span }),
		None: (span: Span): Node => ({ kind: 'null', span }),
	});

const FROM_IMPORT =
	/^[ \t]*from[ \t]+typesafe_(?:sdk|ai)[\w.]*[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;
const MODULE_IMPORT =
	/^[ \t]*import[ \t]+(typesafe_(?:sdk|ai))(?:[ \t]+as[ \t]+(\w+))?/gm;

function importedNames(text: string): Names {
	const classes = new Map<string, QuestionType>();
	for (const match of text.matchAll(FROM_IMPORT)) {
		const list = (match[1] ?? '').replace(/#[^\n]*/g, '').replace(/[()]/g, '');
		for (const entry of list.split(',')) {
			const [name, , alias] = entry.trim().split(/\s+/);
			const type = CLASS_TYPES[name ?? ''];
			if (type) classes.set(alias ?? (name as string), type);
		}
	}
	const modules = new Set(
		[...text.matchAll(MODULE_IMPORT)].map(
			(match) => match[2] ?? (match[1] as string),
		),
	);
	return { classes, modules };
}

function isIdent(token: Token | undefined, text: string): boolean {
	return token?.kind === 'ident' && token.text === text;
}

const QUESTION_KEYWORDS = new Set(['instructions', 'criteria']);

/**
 * How far a call can be taken for one of the SDK's question classes. A name
 * the file imports from the SDK is one whatever its arguments. Any other
 * `Noul`, `Choice` or `Score` is a wrapper's re-export or someone's own
 * class, and counts only when its arguments are the question keywords.
 */
type Callee = Readonly<{ type: QuestionType; imported: boolean }>;

function calleeAt(source: Source, at: number): Callee | undefined {
	const { tokens, names } = source;
	const token = tokens[at];
	if (token?.kind !== 'ident' || !isPunct(tokens[at + 1], '('))
		return undefined;
	const prev = tokens[at - 1];
	if (prev?.kind === 'ident' && DECLARATORS.has(prev.text)) return undefined;
	const builtIn = CLASS_TYPES[token.text];
	if (!isPunct(prev, '.')) {
		const type = names.classes.get(token.text);
		if (type) return { type, imported: true };
		return builtIn && { type: builtIn, imported: false };
	}
	// `ts.Noul(...)` is the SDK's only when `ts` is the SDK module itself.
	const imported =
		names.modules.has(tokens[at - 2]?.text ?? '') &&
		!isPunct(tokens[at - 3], '.');
	return builtIn && { type: builtIn, imported };
}

function isRequestCall(tokens: ReadonlyArray<Token>, at: number): boolean {
	return (
		isIdent(tokens[at], REQUEST_METHOD) &&
		isPunct(tokens[at + 1], '(') &&
		!isIdent(tokens[at - 1], 'def')
	);
}

// `questions = {...}` and `TRIAGE_QUESTIONS: dict = {...}` hold a request's
// questions even though the request is built somewhere else.
function questionsName(
	tokens: ReadonlyArray<Token>,
	at: number,
): Token | undefined {
	if (!isPunct(tokens[at - 1], '=') || isPunct(tokens[at - 2], '='))
		return undefined;
	const name = tokens
		.slice(Math.max(0, at - 12), at - 1)
		.reverse()
		.find((token) => token.kind === 'ident' && /questions$/i.test(token.text));
	if (!name) return undefined;
	const between = tokens.slice(tokens.indexOf(name) + 1, at - 1);
	// Only an annotation may sit between the name and the `=`.
	return !between.length || isPunct(between[0], ':') ? name : undefined;
}

function readFound(source: Source, at: number): Parsed | undefined {
	const { tokens } = source;
	if (isPunct(tokens[at], '{')) {
		const dict = readDict(source, at);
		const name = dict && questionsName(tokens, at);
		if (!dict || !name) return dict;
		const prop = {
			key: 'questions',
			keySpan: spanOf(name),
			quote: '',
			value: dict.node,
		};
		return {
			node: {
				kind: 'object',
				props: [prop],
				partial: false,
				span: dict.node.span,
			},
			next: dict.next,
		};
	}
	return readCallAt(source, at);
}

/** Every dict literal and SDK call that starts in `[from, to)` and is not inside another. */
function scanRange(
	source: Source,
	from: number,
	to: number,
): ReadonlyArray<Node> {
	const nodes: Node[] = [];
	let i = from;
	while (i < to) {
		const found = readFound(source, i);
		if (!found) {
			i += 1;
			continue;
		}
		nodes.push(found.node);
		i = found.next;
	}
	return nodes;
}

function unreadable(source: Source, from: number, to: number): UnreadableNode {
	const { tokens } = source;
	const start = tokens[from]?.start ?? 0;
	const end =
		to > from ? (tokens[Math.max(from, to - 1)]?.end ?? start) : start;
	return {
		kind: 'unreadable',
		span: { start, end },
		inner: scanRange(source, from, to),
	};
}

function readString(tokens: ReadonlyArray<Token>, at: number): Parsed {
	const first = tokens[at] as Token;
	let value = first.text;
	let end = first.end;
	let i = at + 1;
	// Adjacent literals join on their own, and 'a' + 'b' is as plain to see.
	while (true) {
		const step = isPunct(tokens[i], '+') ? 1 : 0;
		const part = tokens[i + step];
		if (part?.kind !== 'string') break;
		value += part.text;
		end = part.end;
		i += step + 1;
	}
	return {
		node: { kind: 'string', value, span: { start: first.start, end } },
		next: i,
	};
}

function toNumber(text: string): number {
	return Number(text.replace(/_/g, ''));
}

function readNumber(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed | undefined {
	const token = tokens[at] as Token;
	const negative = isPunct(token, '-');
	const digits = negative ? tokens[at + 1] : token;
	if (digits?.kind !== 'number') return undefined;
	const value = negative ? -toNumber(digits.text) : toNumber(digits.text);
	return {
		node: {
			kind: 'number',
			value,
			span: { start: token.start, end: digits.end },
		},
		next: at + (negative ? 2 : 1),
	};
}

// A call to one of this file's own functions, kept as a call for the caller to interpret.
function readOwnCall(source: Source, at: number): Parsed | undefined {
	const { tokens } = source;
	const callee = tokens[at];
	const prev = tokens[at - 1];
	const own =
		callee?.kind === 'ident' &&
		source.calls.has(callee.text) &&
		isPunct(tokens[at + 1], '(') &&
		!isPunct(prev, '.') &&
		!(prev?.kind === 'ident' && DECLARATORS.has(prev.text));
	const list = own ? readList(source, at + 1, ')', true) : undefined;
	if (!callee || !list) return undefined;
	return {
		node: {
			kind: 'call',
			callee: callee.text,
			args: list.items,
			named: list.named,
			span: { start: callee.start, end: list.end },
		},
		next: list.next,
	};
}

function readCallAt(source: Source, at: number): Parsed | undefined {
	const question = readQuestionCall(source, at);
	if (question) return question;
	if (isRequestCall(source.tokens, at)) return readRequestCall(source, at);
	return readOwnCall(source, at);
}

const F_STRING = /^[rR]?[fF][rR]?('''|"""|'|")/;

// The fixed text of an f-string, with a slot for each `{...}`. Bytes are not text.
function formatText(token: Token): string | undefined {
	if (token.kind !== 'template') return undefined;
	const open = F_STRING.exec(token.text);
	if (!open) return undefined;
	const quote = open[1] as string;
	return fillBraces(token.text.slice(open[0].length, -quote.length));
}

// `"Is {} late?".format(name)`: the same slots, filled by a call.
function readFormatted(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed | undefined {
	const called =
		isPunct(tokens[at + 1], '.') &&
		tokens[at + 2]?.text === 'format' &&
		isPunct(tokens[at + 3], '(');
	if (!called) return undefined;
	const first = tokens[at] as Token;
	const next = skipBalanced(tokens, at + 3);
	const span = { start: first.start, end: (tokens[next - 1] as Token).end };
	return { node: slotted(fillBraces(first.text), span), next };
}

function partText(token: Token): string | undefined {
	return token.kind === 'string' ? token.text : formatText(token);
}

function readPrimary(source: Source, at: number): Parsed | undefined {
	const { tokens } = source;
	const token = tokens[at];
	if (!token) return undefined;
	if (token.kind === 'string')
		return readFormatted(tokens, at) ?? readString(tokens, at);
	const text = formatText(token);
	if (text !== undefined)
		return { node: slotted(text, spanOf(token)), next: at + 1 };
	if (isPunct(token, '{')) return readDict(source, at);
	if (isPunct(token, '[')) return readArray(source, at);
	if (isPunct(token, '(')) return readParenthesized(source, at);
	if (token.kind !== 'ident') return readNumber(tokens, at);
	const keyword = KEYWORD_LITERALS[token.text];
	if (keyword) return { node: keyword(spanOf(token)), next: at + 1 };
	return readCallAt(source, at);
}

/** The literal a name is bound to, read where it is defined. */
function readBound(source: Source, at: number): Node | undefined {
	const primary = readPrimary(source, at);
	const whole =
		primary && endsStatement(source.text, source.tokens, primary.next);
	return whole ? primary.node : undefined;
}

function readValue(source: Source, at: number): Parsed {
	const end = skipExpression(source.tokens, at);
	const primary = readPrimary(source, at);
	if (primary?.next === end) return primary;
	const bound = primary
		? undefined
		: source.resolver.resolve(at, end, (valueAt) => readBound(source, valueAt));
	const node =
		bound ??
		readJoined(source.tokens, at, end, partText) ??
		unreadable(source, at, end);
	return { node, next: end };
}

/** The index of the `:` that ends a dict key starting at `at`, or undefined when this is no key. */
function keyEnd(tokens: ReadonlyArray<Token>, at: number): number | undefined {
	let i = at;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, ':')) return i;
		if (token.kind === 'punct' && [',', '}', ')', ']'].includes(token.text))
			return undefined;
		i =
			token.kind === 'punct' && ['(', '[', '{'].includes(token.text)
				? skipBalanced(tokens, i)
				: i + 1;
	}
	return undefined;
}

type Member = Readonly<{
	prop: Prop | undefined;
	/** The value of an entry whose key could not be read. */
	loose?: Node;
	next: number;
}>;

function readEntry(source: Source, at: number): Member | undefined {
	const { tokens } = source;
	if (isPunct(tokens[at], '**'))
		return { prop: undefined, next: skipExpression(tokens, at + 1) };
	const colon = keyEnd(tokens, at);
	// No colon means a set, which is not something a question is written as.
	if (colon === undefined) return undefined;
	const value = readValue(source, colon + 1);
	const key =
		tokens[at]?.kind === 'string' ? readString(tokens, at) : undefined;
	// A key that is a name or an expression is known only at runtime.
	if (key?.next !== colon || key.node.kind !== 'string')
		return { prop: undefined, loose: value.node, next: value.next };
	const quote = (tokens[at] as Token).quote;
	return {
		prop: {
			key: key.node.value,
			keySpan: key.node.span,
			quote,
			value: value.node,
		},
		next: value.next,
	};
}

/**
 * Reads the dict literal opening at `at`. Returns undefined when the braces
 * are a set or a comprehension, so the caller keeps scanning inside them.
 */
function readDict(source: Source, at: number): Parsed<ObjectNode> | undefined {
	const { tokens } = source;
	const open = tokens[at] as Token;
	const props: Prop[] = [];
	const loose: Node[] = [];
	let partial = false;
	let i = at + 1;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, '}')) {
			const span = { start: open.start, end: token.end };
			return {
				node: { kind: 'object', props, partial, span, loose },
				next: i + 1,
			};
		}
		const member = readEntry(source, i);
		if (!member) return undefined;
		if (member.prop) props.push(member.prop);
		if (member.loose) loose.push(member.loose);
		if (!member.prop) partial = true;
		i = isPunct(tokens[member.next], ',') ? member.next + 1 : member.next;
		if (i === member.next && !isPunct(tokens[i], '}')) return undefined;
	}
	return undefined;
}

type Listed = Readonly<{
	items: ReadonlyArray<Node>;
	named: ReadonlyArray<Prop>;
	partial: boolean;
	next: number;
	end: number;
	trailingComma: boolean;
}>;

function keywordAt(
	tokens: ReadonlyArray<Token>,
	at: number,
): Token | undefined {
	const name = tokens[at];
	const assigns = isPunct(tokens[at + 1], '=') && !isPunct(tokens[at + 2], '=');
	return name?.kind === 'ident' && assigns ? name : undefined;
}

/**
 * Reads comma-separated values up to `closer`. `at` is the index of the
 * opener. With `keywords`, `name=value` entries are collected as named.
 */
function readList(
	source: Source,
	at: number,
	closer: string,
	keywords = false,
): Listed | undefined {
	const { tokens } = source;
	const items: Node[] = [];
	const named: Prop[] = [];
	let partial = false;
	let i = at + 1;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, closer)) {
			const trailingComma = isPunct(tokens[i - 1], ',');
			return {
				items,
				named,
				partial,
				next: i + 1,
				end: token.end,
				trailingComma,
			};
		}
		if (isPunct(token, ',')) {
			i += 1;
			continue;
		}
		const spread = isPunct(token, '*') || isPunct(token, '**');
		const keyword = keywords && !spread ? keywordAt(tokens, i) : undefined;
		const value = readValue(source, i + (spread ? 1 : keyword ? 2 : 0));
		if (spread) partial = true;
		if (keyword)
			named.push({
				key: keyword.text,
				keySpan: spanOf(keyword),
				quote: '',
				value: value.node,
			});
		if (!spread && !keyword) items.push(value.node);
		// A value that consumed nothing means the closer is not the one expected.
		if (value.next === i) return undefined;
		// `[f(x) for x in xs]` builds its items when it runs. It is not a list of one.
		const built = tokens
			.slice(i, value.next)
			.some((part) => part.kind === 'ident' && part.text === 'for');
		if (built && value.node.kind === 'unreadable') return undefined;
		i = value.next;
	}
	return undefined;
}

function readArray(source: Source, at: number): Parsed<ArrayNode> | undefined {
	const list = readList(source, at, ']');
	if (!list) return undefined;
	const span = { start: (source.tokens[at] as Token).start, end: list.end };
	return {
		node: { kind: 'array', items: list.items, partial: list.partial, span },
		next: list.next,
	};
}

// `("a" "b")` is one value in brackets. `("a", "b")` is a tuple, read as a list.
function readParenthesized(source: Source, at: number): Parsed | undefined {
	const list = readList(source, at, ')');
	if (!list) return undefined;
	const only = list.items[0];
	const grouped =
		list.items.length === 1 && !list.partial && !list.trailingComma;
	if (only && grouped) return { node: only, next: list.next };
	const span = { start: (source.tokens[at] as Token).start, end: list.end };
	return {
		node: { kind: 'array', items: list.items, partial: list.partial, span },
		next: list.next,
	};
}

/**
 * `Choice(instructions=..., criteria=...)` as the dict it stands for, with
 * the class name in the place of the `type` value. The classes take keywords
 * only, so a positional argument leaves the question partly unknown.
 */
function readQuestionCall(
	source: Source,
	at: number,
): Parsed<ObjectNode> | undefined {
	const callee = calleeAt(source, at);
	const list = callee && readList(source, at + 1, ')', true);
	if (!callee || !list) return undefined;
	const plain = !list.partial && !list.items.length && list.named.length > 0;
	const shaped =
		plain && list.named.every((arg) => QUESTION_KEYWORDS.has(arg.key));
	if (!callee.imported && !shaped) return undefined;
	const name = source.tokens[at] as Token;
	const named = spanOf(name);
	const typeProp: Prop = {
		key: 'type',
		keySpan: named,
		quote: '',
		value: { kind: 'string', value: callee.type, span: named },
	};
	return {
		node: {
			kind: 'object',
			props: [typeProp, ...list.named],
			partial: list.partial || list.items.length > 0,
			span: { start: name.start, end: list.end },
		},
		next: list.next,
	};
}

/** `client.system_one(state, questions, model=...)` as the request body it sends. */
function readRequestCall(
	source: Source,
	at: number,
): Parsed<ObjectNode> | undefined {
	const callee = source.tokens[at] as Token;
	const list = readList(source, at + 1, ')', true);
	if (!list) return undefined;
	const positional = list.items.flatMap((value, index): Prop[] => {
		const key = REQUEST_POSITIONS[index];
		return key ? [{ key, keySpan: value.span, quote: '', value }] : [];
	});
	return {
		node: {
			kind: 'object',
			props: [...positional, ...list.named],
			partial: list.partial,
			span: { start: callee.start, end: list.end },
		},
		next: list.next,
	};
}

/**
 * Every outermost dict literal and SDK call in Python source, as the same
 * tree the JavaScript reader produces, so one set of rules serves both. A
 * question class is read only under a name the file imports from the SDK.
 */
export function readPythonNodes(
	text: string,
	tokens: ReadonlyArray<Token> = tokenizePython(text),
	calls: ReadonlySet<string> = new Set(),
): ReadonlyArray<Node> {
	const source: Source = {
		text,
		tokens,
		names: importedNames(text),
		resolver: createResolver(tokens, 'python'),
		calls,
	};
	return scanRange(source, 0, tokens.length);
}
