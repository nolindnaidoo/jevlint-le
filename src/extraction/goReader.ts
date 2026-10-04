import type { Node, Span } from '../types';
import { createResolver } from './bindings';
import {
	createReader,
	type Dialect,
	type Parsed,
	type Reader,
	type TypePrefix,
} from './braceReader';
import { isPunct, skipBalanced } from './cursor';
import { fillVerbs, slotted } from './slots';
import type { Token } from './tokens';

// An identifier before `{` that opens a block and never a literal.
const KEYWORDS = new Set([
	'if',
	'for',
	'switch',
	'select',
	'else',
	'func',
	'struct',
	'interface',
	'range',
	'go',
	'defer',
	'return',
	'case',
	'default',
	'type',
	'var',
	'const',
	'package',
	'import',
	'chan',
]);
// Types whose literals are plain data, with no field names of their own.
const BUILT_IN = new Set(['string', 'any', 'bool', 'int', 'int64', 'float64']);
const FIELD_ALIASES: Readonly<Record<string, string>> = Object.freeze({
	kind: 'type',
	questiontype: 'type',
});

type TypeEnd = Readonly<{ end: number; name: Token | undefined }>;

/** The index past a type written at `at`, such as `map[string]any`, `[]string` or `pkg.Question`. */
function typeEnd(
	tokens: ReadonlyArray<Token>,
	at: number,
): TypeEnd | undefined {
	const token = tokens[at];
	if (!token) return undefined;
	if (isPunct(token, '*') || isPunct(token, '&'))
		return typeEnd(tokens, at + 1);
	if (isPunct(token, '[')) return typeEnd(tokens, skipBalanced(tokens, at));
	if (token.kind !== 'ident') return undefined;
	if (token.text === 'map' && isPunct(tokens[at + 1], '['))
		return typeEnd(tokens, skipBalanced(tokens, at + 1));
	if (token.text === 'interface' && isPunct(tokens[at + 1], '{'))
		return { end: skipBalanced(tokens, at + 1), name: undefined };
	if (KEYWORDS.has(token.text)) return undefined;
	const qualified =
		isPunct(tokens[at + 1], '.') && tokens[at + 2]?.kind === 'ident';
	return qualified
		? { end: at + 3, name: tokens[at + 2] }
		: { end: at + 1, name: token };
}

function typeAt(
	tokens: ReadonlyArray<Token>,
	at: number,
): TypePrefix | undefined {
	const first = tokens[at];
	const map =
		first?.kind === 'ident' &&
		first.text === 'map' &&
		isPunct(tokens[at + 1], '[');
	const list = isPunct(first, '[');
	const start = isPunct(first, '&') ? at + 1 : at;
	if (isPunct(tokens[start - 1], '.') && start === at) return undefined;
	const type = typeEnd(tokens, start);
	if (!type || !isPunct(tokens[type.end], '{')) return undefined;
	const kind = map ? 'map' : list ? 'list' : 'named';
	return {
		open: type.end,
		kind,
		name: kind === 'named' ? type.name : undefined,
		custom: type.name !== undefined && !BUILT_IN.has(type.name.text),
	};
}

// `fmt.Sprintf("Is %s late?", name)` as its fixed text, with a slot for each verb.
function readSprintf(reader: Reader, at: number): Parsed | undefined {
	const { tokens } = reader;
	const called =
		tokens[at]?.text === 'fmt' &&
		isPunct(tokens[at + 1], '.') &&
		tokens[at + 2]?.text === 'Sprintf' &&
		isPunct(tokens[at + 3], '(');
	const wording = tokens[at + 4];
	if (!called || wording?.kind !== 'string') return undefined;
	const next = skipBalanced(tokens, at + 3);
	const span = {
		start: (tokens[at] as Token).start,
		end: (tokens[next - 1] as Token).end,
	};
	return { node: slotted(fillVerbs(wording.text), span), next };
}

const GO: Dialect = Object.freeze({
	keywords: Object.freeze({
		true: (span: Span): Node => ({ kind: 'boolean', value: true, span }),
		false: (span: Span): Node => ({ kind: 'boolean', value: false, span }),
		nil: (span: Span): Node => ({ kind: 'null', span }),
	}),
	typeAt,
	braceLists: true,
	// Exported fields are capitalised. The API's names are not.
	fieldKey: (name: string) => {
		const lower = name.toLowerCase();
		return FIELD_ALIASES[lower] ?? lower;
	},
	unwrap: readSprintf,
	skipConversions: (_tokens: ReadonlyArray<Token>, at: number) => at,
	patternsLookLikeLiterals: false,
	pairLists: false,
});

/**
 * Every outermost literal in Go source that could hold a question: a map
 * with string keys, a struct with a `Type` field, and a struct named for a
 * question type.
 */
export function readGoNodes(
	text: string,
	tokens: ReadonlyArray<Token>,
	calls: ReadonlySet<string> = new Set(),
): ReadonlyArray<Node> {
	const resolver = createResolver(tokens, 'go');
	return createReader(text, tokens, GO, resolver, calls).scan(0, tokens.length);
}
