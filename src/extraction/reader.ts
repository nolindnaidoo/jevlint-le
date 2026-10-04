import type {
	ArrayNode,
	CallNode,
	Node,
	ObjectNode,
	Prop,
	Span,
	UnreadableNode,
} from '../types';
import { createResolver, endsStatement, type Resolver } from './bindings';
import { isPunct, skipBalanced, skipExpression, spanOf } from './cursor';
import { fillSubstitutions, readJoined, slotted } from './slots';
import { decode, type Token, tokenize } from './tokens';

type Parsed<T extends Node = Node> = Readonly<{ node: T; next: number }>;
type Member = Readonly<{ prop: Prop | undefined; next: number }>;

export const HELPERS: ReadonlySet<string> = new Set([
	'noul',
	'choice',
	'score',
]);

const MODIFIERS = new Set(['async', 'get', 'set', 'static']);
const DECLARATORS = new Set([
	'function',
	'async',
	'get',
	'set',
	'static',
	'public',
	'private',
	'protected',
	'override',
	'abstract',
]);
const TYPE_ASSERTIONS = new Set(['as', 'satisfies']);
const KEYWORD_LITERALS: Readonly<Record<string, (span: Span) => Node>> =
	Object.freeze({
		true: (span: Span): Node => ({ kind: 'boolean', value: true, span }),
		false: (span: Span): Node => ({ kind: 'boolean', value: false, span }),
		null: (span: Span): Node => ({ kind: 'null', span }),
	});

const NO_CALLS: ReadonlySet<string> = new Set();

type Context = Readonly<{
	text: string;
	resolver: Resolver;
	/** Names of this file's own functions whose calls are to be read. */
	calls: ReadonlySet<string>;
}>;

// The functions below pass the tokens to one another, so what else they need
// about the file is looked up by them.
const CONTEXTS = new WeakMap<ReadonlyArray<Token>, Context>();

/** The literal a name is bound to, read where it is defined. */
function readBound(tokens: ReadonlyArray<Token>, at: number): Node | undefined {
	const primary = readPrimary(tokens, at);
	if (!primary) return undefined;
	const after = tokens[primary.next];
	const asserted = after?.kind === 'ident' && TYPE_ASSERTIONS.has(after.text);
	const text = CONTEXTS.get(tokens)?.text ?? '';
	return asserted || endsStatement(text, tokens, primary.next)
		? primary.node
		: undefined;
}

function resolved(
	tokens: ReadonlyArray<Token>,
	at: number,
	end: number,
): Node | undefined {
	return CONTEXTS.get(tokens)?.resolver.resolve(at, end, (valueAt) =>
		readBound(tokens, valueAt),
	);
}

function isHelperCall(tokens: ReadonlyArray<Token>, at: number): boolean {
	const token = tokens[at];
	const known =
		token?.kind === 'ident' &&
		(HELPERS.has(token.text) || CONTEXTS.get(tokens)?.calls.has(token.text));
	if (!known) return false;
	if (!isPunct(tokens[at + 1], '(')) return false;
	const prev = tokens[at - 1];
	// `answers.choice(key)` is someone's method and `function choice(` or
	// `choice(name) {` declares one. None of them is the SDK's helper.
	if (isPunct(prev, '.')) return false;
	if (prev?.kind === 'ident' && DECLARATORS.has(prev.text)) return false;
	const after = tokens[skipBalanced(tokens, at + 1)];
	if (isPunct(after, '{')) return false;
	// `score(key: string): Answer` is a signature. `a ? score(x, y) : z` is a call.
	return !(isPunct(after, ':') && !isPunct(prev, '?'));
}

function readFound(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed | undefined {
	if (isPunct(tokens[at], '{')) return readObject(tokens, at);
	if (isHelperCall(tokens, at)) return readCall(tokens, at);
	return undefined;
}

/** Every object literal and helper call that starts in `[from, to)` and is not inside another. */
function scanRange(
	tokens: ReadonlyArray<Token>,
	from: number,
	to: number,
): ReadonlyArray<Node> {
	const nodes: Node[] = [];
	let i = from;
	while (i < to) {
		const found = readFound(tokens, i);
		if (!found) {
			i += 1;
			continue;
		}
		nodes.push(found.node);
		i = found.next;
	}
	return nodes;
}

function unreadable(
	tokens: ReadonlyArray<Token>,
	from: number,
	to: number,
): UnreadableNode {
	const first = tokens[from];
	const last = tokens[Math.max(from, to - 1)];
	const start = first?.start ?? 0;
	const end = to > from ? (last?.end ?? start) : start;
	return {
		kind: 'unreadable',
		span: { start, end },
		inner: scanRange(tokens, from, to),
	};
}

function readString(tokens: ReadonlyArray<Token>, at: number): Parsed {
	const first = tokens[at] as Token;
	let value = first.text;
	let end = first.end;
	let i = at + 1;
	// 'a' + 'b' is still a literal the reader can see whole.
	while (isPunct(tokens[i], '+') && tokens[i + 1]?.kind === 'string') {
		const part = tokens[i + 1] as Token;
		value += part.text;
		end = part.end;
		i += 2;
	}
	return {
		node: { kind: 'string', value, span: { start: first.start, end } },
		next: i,
	};
}

function toNumber(text: string): number {
	return Number(text.replace(/_/g, '').replace(/n$/, ''));
}

function readPrimary(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed | undefined {
	const token = tokens[at];
	if (!token) return undefined;
	if (token.kind === 'string') return readString(tokens, at);
	if (token.kind === 'template') {
		return { node: slotted(templateText(token), spanOf(token)), next: at + 1 };
	}
	if (token.kind === 'number') {
		return {
			node: {
				kind: 'number',
				value: toNumber(token.text),
				span: spanOf(token),
			},
			next: at + 1,
		};
	}
	if (isPunct(token, '-') && tokens[at + 1]?.kind === 'number') {
		const digits = tokens[at + 1] as Token;
		const span = { start: token.start, end: digits.end };
		return {
			node: { kind: 'number', value: -toNumber(digits.text), span },
			next: at + 2,
		};
	}
	if (isPunct(token, '{')) return readObject(tokens, at);
	if (isPunct(token, '[')) return readArray(tokens, at);
	if (isHelperCall(tokens, at)) return readCall(tokens, at);
	if (token.kind !== 'ident') return undefined;
	const keyword = KEYWORD_LITERALS[token.text];
	if (!keyword) return undefined;
	return { node: keyword(spanOf(token)), next: at + 1 };
}

// The fixed text of a template literal, with a slot for each `${...}`.
function templateText(token: Token): string {
	return decode(fillSubstitutions(token.text.slice(1, -1)));
}

function partText(token: Token): string | undefined {
	if (token.kind === 'string') return token.text;
	return token.kind === 'template' ? templateText(token) : undefined;
}

function readValue(tokens: ReadonlyArray<Token>, at: number): Parsed {
	const end = skipExpression(tokens, at);
	const primary = readPrimary(tokens, at);
	if (!primary) {
		const node =
			resolved(tokens, at, end) ??
			readJoined(tokens, at, end, partText) ??
			unreadable(tokens, at, end);
		return { node, next: end };
	}
	if (primary.next === end) return primary;
	const joined = readJoined(tokens, at, end, partText);
	if (joined) return { node: joined, next: end };
	const after = tokens[primary.next];
	// `as const` and `satisfies T` change the type, not the value.
	if (after?.kind === 'ident' && TYPE_ASSERTIONS.has(after.text))
		return { node: primary.node, next: end };
	return { node: unreadable(tokens, at, end), next: end };
}

function isKeyStart(token: Token | undefined): boolean {
	if (!token) return false;
	return (
		token.kind === 'ident' ||
		token.kind === 'string' ||
		token.kind === 'number' ||
		isPunct(token, '[')
	);
}

function skipModifiers(tokens: ReadonlyArray<Token>, at: number): number {
	let i = at;
	while (isModifier(tokens[i]) && isKeyStart(tokens[i + 1])) i += 1;
	return i;
}

function isModifier(token: Token | undefined): boolean {
	if (isPunct(token, '*')) return true;
	return token?.kind === 'ident' && MODIFIERS.has(token.text);
}

/** The index past a method's parameter list and body, or undefined when this is not a method. */
function skipMethod(
	tokens: ReadonlyArray<Token>,
	at: number,
): number | undefined {
	const afterParams = skipBalanced(tokens, at);
	if (!isPunct(tokens[afterParams], '{')) return undefined;
	return skipBalanced(tokens, afterParams);
}

function readComputedMember(
	tokens: ReadonlyArray<Token>,
	at: number,
): Member | undefined {
	const afterKey = skipBalanced(tokens, at);
	if (isPunct(tokens[afterKey], ':'))
		return { prop: undefined, next: readValue(tokens, afterKey + 1).next };
	if (!isPunct(tokens[afterKey], '(')) return undefined;
	const afterMethod = skipMethod(tokens, afterKey);
	return afterMethod === undefined
		? undefined
		: { prop: undefined, next: afterMethod };
}

function readNamedMember(
	tokens: ReadonlyArray<Token>,
	at: number,
): Member | undefined {
	const key = tokens[at];
	if (
		!key ||
		key.kind === 'punct' ||
		key.kind === 'template' ||
		key.kind === 'regex'
	)
		return undefined;
	const named = { key: key.text, keySpan: spanOf(key), quote: key.quote };
	const after = tokens[at + 1];
	if (isPunct(after, ':')) {
		const value = readValue(tokens, at + 2);
		return { prop: { ...named, value: value.node }, next: value.next };
	}
	if (isPunct(after, ',') || isPunct(after, '}')) {
		// Shorthand `{ questions }`: the name is known, the value is somewhere else.
		return {
			prop: {
				...named,
				value: resolved(tokens, at, at + 1) ?? {
					kind: 'unreadable',
					span: named.keySpan,
					inner: [],
				},
			},
			next: at + 1,
		};
	}
	if (!isPunct(after, '(')) return undefined;
	const afterMethod = skipMethod(tokens, at + 1);
	if (afterMethod === undefined) return undefined;
	return {
		prop: { ...named, value: unreadable(tokens, at + 1, afterMethod) },
		next: afterMethod,
	};
}

function readMember(
	tokens: ReadonlyArray<Token>,
	at: number,
): Member | undefined {
	if (isPunct(tokens[at], '...'))
		return { prop: undefined, next: skipExpression(tokens, at + 1) };
	const start = skipModifiers(tokens, at);
	if (isPunct(tokens[start], '[')) return readComputedMember(tokens, start);
	return readNamedMember(tokens, start);
}

/**
 * Reads the object literal opening at `at`. Returns undefined when the braces
 * turn out to be something else, such as a block or a type with `;` members,
 * so the caller keeps scanning inside them.
 */
function readObject(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed<ObjectNode> | undefined {
	const open = tokens[at] as Token;
	const props: Prop[] = [];
	let partial = false;
	let i = at + 1;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, '}')) {
			return {
				node: {
					kind: 'object',
					props,
					partial,
					span: { start: open.start, end: token.end },
				},
				next: i + 1,
			};
		}
		const member = readMember(tokens, i);
		if (!member) return undefined;
		if (member.prop) props.push(member.prop);
		if (!member.prop) partial = true;
		i = isPunct(tokens[member.next], ',') ? member.next + 1 : member.next;
		if (i === member.next && !isPunct(tokens[i], '}')) return undefined;
	}
	return undefined;
}

type Listed = Readonly<{
	items: ReadonlyArray<Node>;
	partial: boolean;
	next: number;
	end: number;
}>;

/** Reads comma-separated values up to `closer`. `at` is the index of the opener. */
function readList(
	tokens: ReadonlyArray<Token>,
	at: number,
	closer: string,
): Listed | undefined {
	const items: Node[] = [];
	let partial = false;
	let i = at + 1;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, closer))
			return { items, partial, next: i + 1, end: token.end };
		if (isPunct(token, ',')) {
			i += 1;
			continue;
		}
		const spread = isPunct(token, '...');
		const value = readValue(tokens, spread ? i + 1 : i);
		if (spread) partial = true;
		if (!spread) items.push(value.node);
		// A value that consumed nothing means the closer is not the one expected.
		if (value.next === i) return undefined;
		i = value.next;
	}
	return undefined;
}

function readArray(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed<ArrayNode> | undefined {
	const list = readList(tokens, at, ']');
	if (!list) return undefined;
	const span = { start: (tokens[at] as Token).start, end: list.end };
	return {
		node: { kind: 'array', items: list.items, partial: list.partial, span },
		next: list.next,
	};
}

function readCall(
	tokens: ReadonlyArray<Token>,
	at: number,
): Parsed<CallNode> | undefined {
	const callee = tokens[at] as Token;
	const list = readList(tokens, at + 1, ')');
	if (!list) return undefined;
	const span = { start: callee.start, end: list.end };
	return {
		node: { kind: 'call', callee: callee.text, args: list.items, span },
		next: list.next,
	};
}

/**
 * Every outermost object literal and SDK helper call in the text. JSON and
 * JSONC are a subset of what this reads, so one reader serves every source,
 * and duplicate keys survive, which `JSON.parse` would silently collapse.
 */
export function readNodes(
	text: string,
	tokens: ReadonlyArray<Token> = tokenize(text),
	calls: ReadonlySet<string> = NO_CALLS,
): ReadonlyArray<Node> {
	CONTEXTS.set(tokens, {
		text,
		resolver: createResolver(tokens, 'js'),
		calls,
	});
	return scanRange(tokens, 0, tokens.length);
}
