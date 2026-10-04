import type { Span, Syntax } from '../types';
import { isPunct, skipBalanced } from './cursor';
import type { Token } from './tokens';

export type Fn = Readonly<{
	name: string;
	/** In order. Undefined where a parameter is a pattern or a rest, which has no single name. */
	params: ReadonlyArray<string | undefined>;
	/** From the name to the end of the body. */
	span: Span;
}>;

type Found = Fn | undefined;

function isIdent(token: Token | undefined, text?: string): token is Token {
	return token?.kind === 'ident' && (text === undefined || token.text === text);
}

/** The parameter names in the group opening at `open`, one per comma-separated part. */
function paramsIn(
	tokens: ReadonlyArray<Token>,
	open: number,
): ReadonlyArray<string | undefined> {
	const close = skipBalanced(tokens, open) - 1;
	const params: (string | undefined)[] = [];
	let i = open + 1;
	while (i < close) {
		const first = tokens[i] as Token;
		// `mut name` and `&mut name` still name one value. A pattern or a rest does not.
		const named = isIdent(first, 'mut') ? tokens[i + 1] : first;
		params.push(isIdent(named) ? named.text : undefined);
		while (i < close && !isPunct(tokens[i], ',')) {
			const opens =
				tokens[i]?.kind === 'punct' &&
				['(', '[', '{', '<'].includes((tokens[i] as Token).text);
			i = opens && !isPunct(tokens[i], '<') ? skipBalanced(tokens, i) : i + 1;
		}
		i += 1;
	}
	return params;
}

/** The index of the `{` that opens a body, looking a short way past a return type. */
function bodyOpen(
	tokens: ReadonlyArray<Token>,
	from: number,
): number | undefined {
	let i = from;
	while (i < Math.min(tokens.length, from + 24)) {
		const token = tokens[i] as Token;
		if (isPunct(token, '{')) return i;
		if (isPunct(token, ';') || isPunct(token, '=')) return undefined;
		i =
			isPunct(token, '(') || isPunct(token, '[')
				? skipBalanced(tokens, i)
				: i + 1;
	}
	return undefined;
}

function declared(
	tokens: ReadonlyArray<Token>,
	nameAt: number,
	open: number,
	end: number,
): Found {
	const name = tokens[nameAt];
	const last = tokens[end - 1];
	if (!isIdent(name) || !isPunct(tokens[open], '(') || !last) return undefined;
	return {
		name: name.text,
		params: paramsIn(tokens, open),
		span: { start: name.start, end: last.end },
	};
}

// `function name(...) {...}`, `fn name(...) {...}`, `func name(...) {...}`.
function keywordFunction(keyword: string) {
	return (tokens: ReadonlyArray<Token>, at: number): Found => {
		if (!isIdent(tokens[at], keyword) || !isIdent(tokens[at + 1]))
			return undefined;
		// Rust may put `<T>` between the name and the parameters.
		let open = at + 2;
		while (open < at + 14 && tokens[open] && !isPunct(tokens[open], '('))
			open += 1;
		if (!isPunct(tokens[open], '(')) return undefined;
		const body = bodyOpen(tokens, skipBalanced(tokens, open));
		if (body === undefined) return undefined;
		return declared(tokens, at + 1, open, skipBalanced(tokens, body));
	};
}

// `const name = (a, b) => ...`, with a body in braces, in brackets, or on one line.
function arrowFunction(tokens: ReadonlyArray<Token>, at: number): Found {
	if (!isIdent(tokens[at]) || !isPunct(tokens[at + 1], '=')) return undefined;
	const open = isIdent(tokens[at + 2], 'async') ? at + 3 : at + 2;
	if (!isPunct(tokens[open], '(')) return undefined;
	let arrow = skipBalanced(tokens, open);
	// A return type may sit between the parameters and the arrow.
	while (arrow < open + 40 && tokens[arrow] && !isPunct(tokens[arrow], '=')) {
		if (isPunct(tokens[arrow], ';') || isPunct(tokens[arrow], '{'))
			return undefined;
		arrow += 1;
	}
	if (!isPunct(tokens[arrow], '=') || !isPunct(tokens[arrow + 1], '>'))
		return undefined;
	const body = arrow + 2;
	const grouped = isPunct(tokens[body], '{') || isPunct(tokens[body], '(');
	let end = grouped ? skipBalanced(tokens, body) : body;
	while (!grouped && tokens[end] && !isPunct(tokens[end], ';')) {
		const opens =
			tokens[end]?.kind === 'punct' &&
			['(', '[', '{'].includes((tokens[end] as Token).text);
		end = opens ? skipBalanced(tokens, end) : end + 1;
	}
	return declared(tokens, at, open, end);
}

// `def name(a, b):`, with the body running to the next definition.
function pythonFunction(tokens: ReadonlyArray<Token>, at: number): Found {
	if (!isIdent(tokens[at], 'def') || !isPunct(tokens[at + 2], '('))
		return undefined;
	let end = skipBalanced(tokens, at + 2);
	while (
		tokens[end] &&
		!isIdent(tokens[end], 'def') &&
		!isIdent(tokens[end], 'class')
	)
		end += 1;
	return declared(tokens, at + 1, at + 2, end);
}

const FINDERS: Readonly<
	Record<
		Syntax,
		ReadonlyArray<(tokens: ReadonlyArray<Token>, at: number) => Found>
	>
> = Object.freeze({
	js: [keywordFunction('function'), arrowFunction],
	python: [pythonFunction],
	rust: [keywordFunction('fn')],
	go: [keywordFunction('func')],
});

// A method is called on something, and the reader does not know on what.
const RECEIVERS = new Set(['self', 'cls', 'this']);

/**
 * The functions a file defines by a name that is its only use as one. A name
 * defined twice could be either at a call, so neither is returned.
 */
export function findFunctions(
	tokens: ReadonlyArray<Token>,
	syntax: Syntax,
): ReadonlyMap<string, Fn> {
	const found = tokens.flatMap((_, at) =>
		FINDERS[syntax].flatMap((finder) => finder(tokens, at) ?? []),
	);
	const counts = new Map<string, number>();
	for (const fn of found) counts.set(fn.name, (counts.get(fn.name) ?? 0) + 1);
	const usable = found.filter(
		(fn) => counts.get(fn.name) === 1 && !RECEIVERS.has(fn.params[0] ?? ''),
	);
	return new Map(usable.map((fn) => [fn.name, fn]));
}
