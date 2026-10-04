import type { Node, Span } from '../types';
import { createResolver } from './bindings';
import {
	createReader,
	type Dialect,
	type Parsed,
	type Reader,
	type TypePrefix,
} from './braceReader';
import { isPunct, skipBalanced, spanOf } from './cursor';
import { fillBraces, slotted } from './slots';
import type { Token } from './tokens';

// After one of these an identifier before `{` opens a block or a definition.
const NOT_A_LITERAL = new Set([
	'struct',
	'enum',
	'union',
	'impl',
	'trait',
	'mod',
	'fn',
	'match',
	'if',
	'while',
	'for',
	'in',
	'loop',
	'else',
	'unsafe',
	'async',
	'move',
	'where',
	'dyn',
	'extern',
	'type',
]);
const KEYWORDS = new Set([
	...NOT_A_LITERAL,
	'let',
	'return',
	'pub',
	'use',
	'const',
	'static',
]);
const FIELD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	kind: 'type',
	qtype: 'type',
	question_type: 'type',
});
// Calls that change how a value is held and not what it is.
const WRAPPERS = new Set([
	'Some',
	'String::from',
	'Value::from',
	'Value::String',
	'Box::new',
	'Arc::new',
	'Rc::new',
	'Cow::Borrowed',
	'Cow::Owned',
]);
const MAPS = new Set(['HashMap::from', 'BTreeMap::from', 'IndexMap::from']);
const CONVERSIONS = new Set([
	'into',
	'to_string',
	'to_owned',
	'as_str',
	'as_ref',
	'clone',
	'to_vec',
]);

/** The index past a path such as `serde_json::Value`, starting at an identifier. */
function pathEnd(tokens: ReadonlyArray<Token>, at: number): number {
	let i = at;
	while (tokens[i]?.kind === 'ident' && isPunct(tokens[i + 1], '::')) i += 2;
	return tokens[i]?.kind === 'ident' ? i + 1 : at;
}

function typeAt(
	tokens: ReadonlyArray<Token>,
	at: number,
): TypePrefix | undefined {
	const first = tokens[at];
	if (first?.kind !== 'ident' || KEYWORDS.has(first.text)) return undefined;
	const prev = tokens[at - 1];
	if (prev?.kind === 'ident' && NOT_A_LITERAL.has(prev.text)) return undefined;
	if (isPunct(prev, '->') || isPunct(prev, '::')) return undefined;
	const end = pathEnd(tokens, at);
	if (end === at || !isPunct(tokens[end], '{')) return undefined;
	return { open: end, kind: 'named', name: tokens[end - 1], custom: true };
}

// `json!(x)` and `vec![a, b]`, with or without a path before the name.
function readMacro(reader: Reader, at: number): Parsed | undefined {
	const { tokens } = reader;
	const name = tokens[at] as Token;
	if (!isPunct(tokens[at + 1], '!')) return undefined;
	const open = tokens[at + 2];
	const wording = tokens[at + 3];
	if (
		name.text === 'format' &&
		isPunct(open, '(') &&
		wording?.kind === 'string'
	) {
		const next = skipBalanced(tokens, at + 2);
		const span = { start: name.start, end: (tokens[next - 1] as Token).end };
		return { node: slotted(fillBraces(wording.text), span), next };
	}
	if (name.text === 'json' && isPunct(open, '(')) {
		const list = reader.readList(at + 2, ')');
		const only = list?.items.length === 1 ? list.items[0] : undefined;
		return list && only ? { node: only, next: list.next } : undefined;
	}
	if (name.text !== 'vec' || !isPunct(open, '[')) return undefined;
	return reader.readArray(at + 2);
}

// `Question::noul("Is it late?", ...)`: every project orders the rest of the
// arguments its own way, so only the wording is taken and the rest is unknown.
function readConstructor(
	reader: Reader,
	at: number,
	end: number,
): Parsed | undefined {
	const { tokens } = reader;
	const name = tokens[end - 1] as Token;
	const lower = ['noul', 'choice', 'score'].includes(name.text);
	if (!lower || end - at < 3 || tokens[at + 1]?.text !== '::') return undefined;
	const list = reader.readList(end, ')');
	const wording = list?.items[0];
	if (!list || wording?.kind !== 'string') return undefined;
	const span = spanOf(name);
	return {
		node: {
			kind: 'object',
			props: [
				{
					key: 'type',
					keySpan: span,
					quote: '',
					value: { kind: 'string', value: name.text, span },
				},
				{
					key: 'instructions',
					keySpan: wording.span,
					quote: '',
					value: wording,
				},
			],
			partial: true,
			span: { start: (tokens[at] as Token).start, end: list.end },
		},
		next: list.next,
	};
}

// `BTreeMap::from([("late", "Arrived late"), ("other", None)])` as the map it builds.
function readMap(reader: Reader, open: number): Parsed | undefined {
	const { tokens } = reader;
	if (!isPunct(tokens[open + 1], '[')) return undefined;
	const pairs = reader.readArray(open + 1);
	if (pairs?.node.kind !== 'object' || !isPunct(tokens[pairs.next], ')'))
		return undefined;
	return { node: pairs.node, next: pairs.next + 1 };
}

function unwrap(reader: Reader, at: number): Parsed | undefined {
	const { tokens } = reader;
	if (tokens[at]?.kind !== 'ident' || isPunct(tokens[at - 1], '::'))
		return undefined;
	const end = pathEnd(tokens, at);
	if (end === at) return undefined;
	const macro = readMacro(reader, end - 1);
	if (macro) return macro;
	if (!isPunct(tokens[end], '(')) return undefined;
	const built = readConstructor(reader, at, end);
	if (built) return built;
	// The last two segments name the call: `std::collections::HashMap::from` is `HashMap::from`.
	const name = tokens
		.slice(Math.max(at, end - 3), end)
		.map((token) => token.text)
		.join('');
	if (MAPS.has(name)) return readMap(reader, end);
	if (!WRAPPERS.has(name)) return undefined;
	const list = reader.readList(end, ')');
	const only = list?.items.length === 1 ? list.items[0] : undefined;
	return list && only ? { node: only, next: list.next } : undefined;
}

function skipConversions(tokens: ReadonlyArray<Token>, at: number): number {
	let i = at;
	while (
		isPunct(tokens[i], '.') &&
		CONVERSIONS.has(tokens[i + 1]?.text ?? '') &&
		isPunct(tokens[i + 2], '(') &&
		isPunct(tokens[i + 3], ')')
	)
		i += 4;
	return i;
}

const RUST: Dialect = Object.freeze({
	keywords: Object.freeze({
		true: (span: Span): Node => ({ kind: 'boolean', value: true, span }),
		false: (span: Span): Node => ({ kind: 'boolean', value: false, span }),
		null: (span: Span): Node => ({ kind: 'null', span }),
		None: (span: Span): Node => ({ kind: 'null', span }),
	}),
	typeAt,
	braceLists: false,
	fieldKey: (name: string) => FIELD_ALIASES[name] ?? name,
	unwrap,
	skipConversions,
	patternsLookLikeLiterals: true,
	pairLists: true,
});

/**
 * Every outermost literal in Rust source that could hold a question: the
 * JSON inside `json!`, a struct or variant named for a question type, and a
 * `::noul(...)` style constructor. `typeInName` decides what a name means.
 */
export function readRustNodes(
	text: string,
	tokens: ReadonlyArray<Token>,
	calls: ReadonlySet<string> = new Set(),
): ReadonlyArray<Node> {
	const resolver = createResolver(tokens, 'rust');
	return createReader(text, tokens, RUST, resolver, calls).scan(
		0,
		tokens.length,
	);
}
