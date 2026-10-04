import type {
	ArrayNode,
	Node,
	Prop,
	QuestionType,
	Span,
	UnreadableNode,
} from '../types';
import { endsStatement, type Resolver } from './bindings';
import { isPunct, skipBalanced, skipExpression, spanOf } from './cursor';
import { readJoined } from './slots';
import type { Token } from './tokens';

export type Parsed<T extends Node = Node> = Readonly<{ node: T; next: number }>;

/** A type written before a `{`: where the brace is, and what the literal is. */
export type TypePrefix = Readonly<{
	open: number;
	kind: 'map' | 'list' | 'named';
	/** The token naming a struct or variant, the last segment of its path. */
	name: Token | undefined;
	/** True when the literal is of a type the project defines, so its field names are the project's and not the API's. */
	custom: boolean;
}>;

export type Reader = Readonly<{
	tokens: ReadonlyArray<Token>;
	dialect: Dialect;
	readValue: (at: number) => Parsed;
	readList: (at: number, closer: string) => Listed | undefined;
	/** The `[...]` opening at `at`: a list, or a map where the dialect writes one as pairs. */
	readArray: (at: number) => Parsed | undefined;
}>;

/**
 * What differs between the languages that write a literal as a type and a
 * brace: Rust and Go so far. Everything else about reading one is shared.
 */
export type Dialect = Readonly<{
	keywords: Readonly<Record<string, (span: Span) => Node>>;
	typeAt: (tokens: ReadonlyArray<Token>, at: number) => TypePrefix | undefined;
	/** True where a brace can hold a plain list, as in Go's `[]string{"a", "b"}`. */
	braceLists: boolean;
	/** A struct field's name as the API spells it. */
	fieldKey: (name: string) => string;
	/** A value written inside a wrapper that changes its type and not its content, such as `Some(x)`. */
	unwrap: (reader: Reader, at: number) => Parsed | undefined;
	/** The index past any trailing conversions, such as `.to_string()`. */
	skipConversions: (tokens: ReadonlyArray<Token>, at: number) => number;
	/**
	 * True where a struct literal and a pattern or a type definition look the
	 * same, so a typed question counts only if a value in it could be read.
	 */
	patternsLookLikeLiterals: boolean;
	/** True where a map is commonly written as a list of pairs: `[("late", "Arrived late"), ...]`. */
	pairLists: boolean;
}>;

export type Listed = Readonly<{
	items: ReadonlyArray<Node>;
	partial: boolean;
	next: number;
	end: number;
}>;

const QUESTION_FIELDS = new Set(['instructions', 'criteria']);
// The names the API uses. A struct with any other field is the project's own shape.
const WIRE_FIELDS = new Set([
	'type',
	'instructions',
	'criteria',
	'questions',
	'state',
	'model',
]);
const TYPE_WORDS: ReadonlyArray<QuestionType> = ['noul', 'choice', 'score'];
const LITERAL_KINDS = new Set(['string', 'array', 'object', 'null']);

/** The one question type a name mentions, as in `NoulQuestion` or `TypeChoice`. */
export function typeInName(name: string): QuestionType | undefined {
	const lower = name.toLowerCase();
	const found = TYPE_WORDS.filter((word) => lower.includes(word));
	return found.length === 1 ? found[0] : undefined;
}

/** The index of the `:` that ends a key starting at `at`, or undefined when no key starts there. */
export function keyEnd(
	tokens: ReadonlyArray<Token>,
	at: number,
): number | undefined {
	let i = at;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (isPunct(token, ':')) return i;
		if (token.kind === 'punct' && [',', '}', ')', ']'].includes(token.text))
			return undefined;
		const opens =
			token.kind === 'punct' && ['(', '[', '{'].includes(token.text);
		i = opens ? skipBalanced(tokens, i) : i + 1;
	}
	return undefined;
}

type Entry = Readonly<{
	prop?: Prop;
	/** The value of an entry whose key is known only at runtime. */
	loose?: Node;
	item?: Node;
	partial: boolean;
	next: number;
}>;

function stringNode(value: string, span: Span): Node {
	return { kind: 'string', value, span };
}

export function createReader(
	text: string,
	tokens: ReadonlyArray<Token>,
	dialect: Dialect,
	resolver: Resolver,
	calls: ReadonlySet<string>,
): Reader &
	Readonly<{ scan: (from: number, to: number) => ReadonlyArray<Node> }> {
	// Literals of a type the project defines. What their fields serialise to is not known here.
	const custom = new WeakSet<Node>();
	const isCustom = (node: Node): boolean =>
		custom.has(node) ||
		(node.kind === 'array' && node.items.some((item) => custom.has(item)));

	const unreadable = (from: number, to: number): UnreadableNode => {
		const start = tokens[from]?.start ?? 0;
		const end =
			to > from ? (tokens[Math.max(from, to - 1)]?.end ?? start) : start;
		return { kind: 'unreadable', span: { start, end }, inner: scan(from, to) };
	};

	const readString = (at: number): Parsed => {
		const first = tokens[at] as Token;
		let value = first.text;
		let end = first.end;
		let i = at + 1;
		while (isPunct(tokens[i], '+') && tokens[i + 1]?.kind === 'string') {
			const part = tokens[i + 1] as Token;
			value += part.text;
			end = part.end;
			i += 2;
		}
		return { node: stringNode(value, { start: first.start, end }), next: i };
	};

	const readNumber = (at: number): Parsed | undefined => {
		const token = tokens[at] as Token;
		const negative = isPunct(token, '-');
		const digits = negative ? tokens[at + 1] : token;
		if (digits?.kind !== 'number') return undefined;
		const value = Number.parseFloat(digits.text.replace(/_/g, ''));
		return {
			node: {
				kind: 'number',
				value: negative ? -value : value,
				span: { start: token.start, end: digits.end },
			},
			next: at + (negative ? 2 : 1),
		};
	};

	const readList = (at: number, closer: string): Listed | undefined => {
		const items: Node[] = [];
		let i = at + 1;
		while (i < tokens.length) {
			const token = tokens[i] as Token;
			if (isPunct(token, closer))
				return { items, partial: false, next: i + 1, end: token.end };
			if (isPunct(token, ',')) {
				i += 1;
				continue;
			}
			const value = readValue(i);
			if (value.next === i) return undefined;
			items.push(value.node);
			i = value.next;
		}
		return undefined;
	};

	// `[("late", "Arrived late"), ("other", None)]` as the map it is turned into.
	const readPairs = (at: number): Parsed | undefined => {
		const props: Prop[] = [];
		let partial = false;
		let i = at + 1;
		while (isPunct(tokens[i], '(')) {
			const key = readValue(i + 1);
			if (!isPunct(tokens[key.next], ',')) return undefined;
			const value = readValue(key.next + 1);
			if (!isPunct(tokens[value.next], ')')) return undefined;
			const named = key.node.kind === 'string' ? key.node : undefined;
			if (named)
				props.push({
					key: named.value,
					keySpan: named.span,
					quote: '"',
					value: value.node,
				});
			if (!named) partial = true;
			i = isPunct(tokens[value.next + 1], ',')
				? value.next + 2
				: value.next + 1;
		}
		const close = tokens[i];
		if (!close || !isPunct(close, ']') || !(props.length || partial))
			return undefined;
		const span = { start: (tokens[at] as Token).start, end: close.end };
		return { node: { kind: 'object', props, partial, span }, next: i + 1 };
	};

	const readArray = (at: number): Parsed | undefined => {
		const pairs = dialect.pairLists ? readPairs(at) : undefined;
		if (pairs) return pairs;
		const list = readList(at, ']');
		if (!list) return undefined;
		const span = { start: (tokens[at] as Token).start, end: list.end };
		const node: ArrayNode = {
			kind: 'array',
			items: list.items,
			partial: false,
			span,
		};
		return { node, next: list.next };
	};

	// `Type: TypeChoice` names the type through a constant. The name is read, never the constant's value.
	const typeFromConstant = (value: Node, from: number, to: number): Node => {
		if (value.kind !== 'unreadable') return value;
		const named = tokens
			.slice(from, to)
			.every(
				(token) => token.kind === 'ident' || ['.', '::'].includes(token.text),
			);
		const type = named ? typeInName(tokens[to - 1]?.text ?? '') : undefined;
		return type ? stringNode(type, value.span) : value;
	};

	const readKeyed = (
		at: number,
		kind: TypePrefix['kind'] | undefined,
	): Entry | undefined => {
		const colon = keyEnd(tokens, at);
		if (colon === undefined) return undefined;
		const value = readValue(colon + 1);
		const key = tokens[at] as Token;
		const single = colon === at + 1;
		if (single && key.kind === 'string') {
			const prop = {
				key: key.text,
				keySpan: spanOf(key),
				quote: key.quote,
				value: value.node,
			};
			return { prop, partial: false, next: value.next };
		}
		// In a map a bare name is a variable. Anywhere else it is a field.
		if (!single || key.kind !== 'ident' || kind === 'map')
			return { loose: value.node, partial: true, next: value.next };
		const name = dialect.fieldKey(key.text);
		// Criteria held in the project's own type could serialise to anything.
		const foreign = name === 'criteria' && isCustom(value.node);
		const node = foreign
			? unreadable(colon + 1, value.next)
			: name === 'type'
				? typeFromConstant(value.node, colon + 1, value.next)
				: value.node;
		return {
			prop: { key: name, keySpan: spanOf(key), quote: '', value: node },
			partial: false,
			next: value.next,
		};
	};

	const readEntry = (
		at: number,
		kind: TypePrefix['kind'] | undefined,
	): Entry | undefined => {
		const token = tokens[at] as Token;
		if (isPunct(token, '..') || isPunct(token, '...'))
			return { partial: true, next: skipExpression(tokens, at + 1) };
		const keyed = readKeyed(at, kind);
		if (keyed) return keyed;
		if (dialect.braceLists) {
			const value = readValue(at);
			return { item: value.node, partial: false, next: value.next };
		}
		// `Noul { instructions, criteria }` names fields whose values are elsewhere.
		const shorthand =
			token.kind === 'ident' &&
			(isPunct(tokens[at + 1], ',') || isPunct(tokens[at + 1], '}'));
		if (!shorthand) return undefined;
		const span = spanOf(token);
		const value: Node = { kind: 'unreadable', span, inner: [] };
		return {
			prop: {
				key: dialect.fieldKey(token.text),
				keySpan: span,
				quote: '',
				value,
			},
			partial: false,
			next: at + 1,
		};
	};

	// A struct or variant named for a question type, holding only a question's fields.
	const asQuestion = (
		props: ReadonlyArray<Prop>,
		name: Token | undefined,
	): Prop | undefined => {
		const type = name && typeInName(name.text);
		if (!type || !props.some((prop) => QUESTION_FIELDS.has(prop.key)))
			return undefined;
		if (props.some((prop) => prop.key === 'type')) return undefined;
		const readable = props.some((prop) => LITERAL_KINDS.has(prop.value.kind));
		if (dialect.patternsLookLikeLiterals && !readable) return undefined;
		const span = spanOf(name);
		return {
			key: 'type',
			keySpan: span,
			quote: '',
			value: stringNode(type, span),
		};
	};

	const readBrace = (at: number, prefix?: TypePrefix): Parsed | undefined => {
		const start = tokens[at] as Token;
		const props: Prop[] = [];
		const loose: Node[] = [];
		const items: Node[] = [];
		let partial = false;
		let i = (prefix?.open ?? at) + 1;
		while (i < tokens.length) {
			const token = tokens[i] as Token;
			if (isPunct(token, '}')) {
				const span = { start: start.start, end: token.end };
				const keyed = props.length > 0 || loose.length > 0 || partial;
				if (keyed && items.length) return undefined;
				const listed = items.length > 0 || prefix?.kind === 'list';
				const type = listed ? undefined : asQuestion(props, prefix?.name);
				// A field the API does not have means this is the project's own shape.
				const fields = props.filter((prop) => prop.quote === '');
				// A struct says its question type in its own type, which is not written here.
				const typeUnseen =
					fields.length > 0 &&
					!type &&
					!props.some((prop) => prop.key === 'type');
				const ownShape =
					typeUnseen || fields.some((prop) => !WIRE_FIELDS.has(prop.key));
				const node: Node = listed
					? { kind: 'array', items, partial, span }
					: {
							kind: 'object',
							props: type ? [type, ...props] : props,
							partial: partial || ownShape,
							span,
							loose,
						};
				if (prefix?.custom && !type) custom.add(node);
				return { node, next: i + 1 };
			}
			const entry = readEntry(i, prefix?.kind);
			if (!entry) return undefined;
			if (entry.prop) props.push(entry.prop);
			if (entry.loose) loose.push(entry.loose);
			if (entry.item) items.push(entry.item);
			partial ||= entry.partial;
			i = isPunct(tokens[entry.next], ',') ? entry.next + 1 : entry.next;
			if (i === entry.next && !isPunct(tokens[i], '}')) return undefined;
		}
		return undefined;
	};

	const readLiteral = (at: number): Parsed | undefined => {
		const prefix = dialect.typeAt(tokens, at);
		if (prefix) return readBrace(at, prefix);
		return isPunct(tokens[at], '{') ? readBrace(at) : undefined;
	};

	// A call to one of this file's own functions, kept as a call for the caller to interpret.
	const readOwnCall = (at: number): Parsed | undefined => {
		const callee = tokens[at];
		const prev = tokens[at - 1];
		const own =
			callee?.kind === 'ident' &&
			calls.has(callee.text) &&
			isPunct(tokens[at + 1], '(') &&
			!isPunct(prev, '.') &&
			!(prev?.kind === 'ident' && ['fn', 'func'].includes(prev.text));
		const list = own ? readList(at + 1, ')') : undefined;
		if (!callee || !list) return undefined;
		const span = { start: callee.start, end: list.end };
		return {
			node: { kind: 'call', callee: callee.text, args: list.items, span },
			next: list.next,
		};
	};

	const readPrimary = (at: number): Parsed | undefined => {
		const token = tokens[at];
		if (!token) return undefined;
		if (isPunct(token, '&')) return readPrimary(at + 1);
		if (token.kind === 'string') return readString(at);
		const literal = readLiteral(at);
		if (literal) return literal;
		if (isPunct(token, '[')) return readArray(at);
		const unwrapped = dialect.unwrap(reader, at) ?? readOwnCall(at);
		if (unwrapped) return unwrapped;
		if (token.kind !== 'ident') return readNumber(at);
		const keyword = dialect.keywords[token.text];
		return keyword && { node: keyword(spanOf(token)), next: at + 1 };
	};

	// The literal a name is bound to, read where it is defined.
	const readBound = (at: number): Node | undefined => {
		const primary = readPrimary(at);
		const next = primary && dialect.skipConversions(tokens, primary.next);
		return primary && next !== undefined && endsStatement(text, tokens, next)
			? primary.node
			: undefined;
	};

	const readValue = (at: number): Parsed => {
		const end = skipExpression(tokens, at);
		const primary = readPrimary(at);
		const next = primary && dialect.skipConversions(tokens, primary.next);
		if (primary && next === end) return { node: primary.node, next: end };
		// `NAME`, `&NAME` or `NAME.to_string()`: a name, held or converted.
		const from = isPunct(tokens[at], '&') ? at + 1 : at;
		const named = tokens[from]?.kind === 'ident' ? from + 1 : from;
		const bare = named > from && dialect.skipConversions(tokens, named) === end;
		const bound = primary
			? undefined
			: resolver.resolve(from, bare ? named : end, readBound);
		const joined = readJoined(tokens, at, end, (token) =>
			token.kind === 'string' ? token.text : undefined,
		);
		return { node: bound ?? joined ?? unreadable(at, end), next: end };
	};

	const scan = (from: number, to: number): ReadonlyArray<Node> => {
		const nodes: Node[] = [];
		let i = from;
		while (i < to) {
			const found =
				readLiteral(i) ?? dialect.unwrap(reader, i) ?? readOwnCall(i);
			if (!found) {
				i += 1;
				continue;
			}
			nodes.push(named(found.node, i));
			i = found.next;
		}
		return nodes;
	};

	// `questions := map[string]any{...}` and `let questions = json!({...})` hold a
	// request's questions even though the request is built somewhere else.
	const named = (node: Node, at: number): Node => {
		if (node.kind !== 'object') return node;
		let i = at - 1;
		// Between the `=` and the literal there may be a macro call and nothing else.
		while (
			i > at - 6 &&
			['(', '!', '::', '&', 'json', 'serde_json'].includes(
				tokens[i]?.text ?? '',
			)
		)
			i -= 1;
		if (!isPunct(tokens[i], '=') && !isPunct(tokens[i], ':=')) return node;
		const name = tokens
			.slice(Math.max(0, i - 4), i)
			.find(
				(token) => token.kind === 'ident' && /questions$/i.test(token.text),
			);
		if (!name) return node;
		const prop = {
			key: 'questions',
			keySpan: spanOf(name),
			quote: '',
			value: node,
		};
		return { kind: 'object', props: [prop], partial: false, span: node.span };
	};

	const reader: Reader = { tokens, dialect, readValue, readList, readArray };
	return { ...reader, scan };
}
