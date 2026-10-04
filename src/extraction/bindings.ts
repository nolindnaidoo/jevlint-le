import type { Node, Syntax } from '../types';
import { isPunct, skipBalanced } from './cursor';
import type { Token } from './tokens';

/** Reads the literal a name is bound to, given the index its value starts at. */
type ReadBound = (valueAt: number) => Node | undefined;

export type Resolver = Readonly<{
	/**
	 * The literal that the expression in `[at, end)` stands for, when it is a
	 * name bound once in this file to a literal, or a member of one. Undefined
	 * for anything else, which the caller then treats as unreadable.
	 */
	resolve: (at: number, end: number, read: ReadBound) => Node | undefined;
}>;

const NONE: Resolver = Object.freeze({ resolve: () => undefined });

function isIdent(token: Token | undefined, text?: string): token is Token {
	return token?.kind === 'ident' && (text === undefined || token.text === text);
}

/** The identifiers inside the group opening at `open`, which is an index of a `(`. */
function namesIn(
	tokens: ReadonlyArray<Token>,
	open: number,
): ReadonlyArray<string> {
	return tokens
		.slice(open + 1, skipBalanced(tokens, open) - 1)
		.filter((token) => token.kind === 'ident')
		.map((token) => token.text);
}

// A group is a parameter list when a body or an arrow follows it.
function jsParameters(tokens: ReadonlyArray<Token>): ReadonlyArray<string> {
	return tokens.flatMap((token, i) => {
		const arrow = isPunct(tokens[i + 1], '=') && isPunct(tokens[i + 2], '>');
		if (isIdent(token) && arrow) return [token.text];
		if (!isPunct(token, '(')) return [];
		const after = skipBalanced(tokens, i);
		const next = tokens[after];
		const body = isPunct(next, '{') || isPunct(next, ':');
		const lambda = isPunct(next, '=') && isPunct(tokens[after + 1], '>');
		return body || lambda ? namesIn(tokens, i) : [];
	});
}

// The groups that follow a keyword which declares a function.
function declaredParameters(
	tokens: ReadonlyArray<Token>,
	keyword: string,
	groups: number,
): ReadonlyArray<string> {
	return tokens.flatMap((token, i) => {
		if (!isIdent(token, keyword)) return [];
		const names: string[] = [];
		let at = i + 1;
		for (let group = 0; group < groups; group += 1) {
			while (at < tokens.length && at < i + 8 && !isPunct(tokens[at], '('))
				at += 1;
			if (!isPunct(tokens[at], '(')) break;
			names.push(...namesIn(tokens, at));
			at = skipBalanced(tokens, at);
		}
		return names;
	});
}

const PARAMETERS: Readonly<
	Record<Syntax, (tokens: ReadonlyArray<Token>) => ReadonlyArray<string>>
> = Object.freeze({
	js: jsParameters,
	python: (tokens) => declaredParameters(tokens, 'def', 1),
	rust: (tokens) => declaredParameters(tokens, 'fn', 1),
	// A method has a receiver group before its parameters.
	go: (tokens) => declaredParameters(tokens, 'func', 2),
});

/** The index a value starts at, when the name at `at` is being bound to one. */
function boundAt(tokens: ReadonlyArray<Token>, at: number): number | undefined {
	const next = tokens[at + 1];
	if (isPunct(next, ':=')) return at + 2;
	if (isPunct(next, '=')) {
		const after = tokens[at + 2];
		return isPunct(after, '=') || isPunct(after, '>') ? undefined : at + 2;
	}
	if (!isPunct(next, ':')) return undefined;
	// `NAME: Type = value`. The type is short and holds no assignment of its own.
	for (let i = at + 2; i < Math.min(tokens.length, at + 16); i += 1) {
		const token = tokens[i] as Token;
		if (isPunct(token, '='))
			return isPunct(tokens[i + 1], '=') ? undefined : i + 1;
		if (token.kind === 'punct' && [';', '{', '(', ')'].includes(token.text))
			return undefined;
	}
	return undefined;
}

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/**
 * Where each name is bound. A name directly inside brackets is a keyword
 * argument or a default, not a binding. One inside a body that is itself
 * inside a call, such as a callback, is a binding like any other.
 */
function bindingSites(
	tokens: ReadonlyArray<Token>,
): ReadonlyMap<string, number[]> {
	const sites = new Map<string, number[]>();
	const open: string[] = [];
	for (const [i, token] of tokens.entries()) {
		if (token.kind === 'punct' && OPENERS.has(token.text))
			open.push(token.text);
		if (token.kind === 'punct' && CLOSERS.has(token.text)) open.pop();
		const inArguments = open[open.length - 1] === '(';
		if (inArguments || !isIdent(token) || isPunct(tokens[i - 1], '.')) continue;
		// `type Question = { ... }` names a type, and in `NAME: Question = ...` so does `Question`.
		if (isIdent(tokens[i - 1], 'type') || isPunct(tokens[i - 1], ':')) continue;
		const value = boundAt(tokens, i);
		if (value === undefined) continue;
		sites.set(token.text, [...(sites.get(token.text) ?? []), value]);
	}
	return sites;
}

const MUTATORS = new Set([
	'push',
	'unshift',
	'splice',
	'append',
	'extend',
	'insert',
	'update',
	'add',
	'set',
	'setdefault',
	'pop',
	'remove',
	'clear',
	'sort',
	'reverse',
	'retain',
]);

// A container that is filled or changed after it is written is not the literal it started as.
function mutatedNames(tokens: ReadonlyArray<Token>): ReadonlySet<string> {
	const names = tokens.flatMap((token, i) => {
		if (!isIdent(token) || isPunct(tokens[i - 1], '.')) return [];
		const next = tokens[i + 1];
		if (isPunct(next, '.')) {
			const member = tokens[i + 2];
			const called =
				isPunct(tokens[i + 3], '(') && MUTATORS.has(member?.text ?? '');
			const assigned =
				isPunct(tokens[i + 3], '=') && !isPunct(tokens[i + 4], '=');
			return called || assigned ? [token.text] : [];
		}
		if (!isPunct(next, '[')) return [];
		const after = skipBalanced(tokens, i + 1);
		const assigned =
			isPunct(tokens[after], '=') && !isPunct(tokens[after + 1], '=');
		return assigned ? [token.text] : [];
	});
	return new Set(names);
}

type Step = string | number;

/** `NAME`, `NAME.a.b` or `NAME["a"][0]` as a name and the path under it. */
function chain(
	tokens: ReadonlyArray<Token>,
	at: number,
	end: number,
): Readonly<{ name: string; path: ReadonlyArray<Step> }> | undefined {
	const first = tokens[at];
	if (!isIdent(first)) return undefined;
	const path: Step[] = [];
	let i = at + 1;
	while (i < end) {
		const key = tokens[i + 1];
		if (isPunct(tokens[i], '.') && isIdent(key)) {
			path.push(key.text);
			i += 2;
			continue;
		}
		const indexed = isPunct(tokens[i], '[') && isPunct(tokens[i + 2], ']');
		if (!indexed || !key || (key.kind !== 'string' && key.kind !== 'number'))
			return undefined;
		path.push(key.kind === 'number' ? Number(key.text) : key.text);
		i += 3;
	}
	return { name: first.text, path };
}

function isEmpty(node: Node): boolean {
	if (node.kind === 'object') return !node.props.length && !node.partial;
	return node.kind === 'array' && !node.items.length;
}

function member(node: Node, step: Step): Node | undefined {
	if (node.kind === 'array' && typeof step === 'number')
		return node.items[step];
	if (node.kind !== 'object') return undefined;
	return node.props.find((prop) => prop.key === String(step))?.value;
}

/**
 * Follows a name to the literal it stands for. Only a name bound exactly once
 * in the file is followed, and never one that is also a function parameter
 * somewhere, because the reader does not know scopes and a parameter of the
 * same name would be a different value.
 */
export function createResolver(
	tokens: ReadonlyArray<Token>,
	syntax: Syntax,
): Resolver {
	const unsafe = new Set([
		...PARAMETERS[syntax](tokens),
		...mutatedNames(tokens),
	]);
	const bound = new Map<string, number>();
	for (const [name, sites] of bindingSites(tokens)) {
		const only = sites.length === 1 ? sites[0] : undefined;
		if (only !== undefined && !unsafe.has(name)) bound.set(name, only);
	}
	if (!bound.size) return NONE;
	// A name whose value mentions itself, directly or through another, is not followed.
	const following = new Set<string>();
	return {
		resolve: (at, end, read) => {
			const found = chain(tokens, at, end);
			const valueAt = found && bound.get(found.name);
			if (!found || valueAt === undefined || following.has(found.name))
				return undefined;
			following.add(found.name);
			const value = read(valueAt);
			following.delete(found.name);
			// An empty container is a starting point for something built later.
			if (value && isEmpty(value)) return undefined;
			return found.path.reduce<Node | undefined>(
				(node, step) => node && member(node, step),
				value,
			);
		},
	};
}

/** True when nothing but the end of a statement follows a value that stops before `next`. */
export function endsStatement(
	text: string,
	tokens: ReadonlyArray<Token>,
	next: number,
): boolean {
	const token = tokens[next];
	const prev = tokens[next - 1];
	if (!token || !prev) return true;
	if (token.kind === 'punct' && [';', ',', ')', '}', ']'].includes(token.text))
		return true;
	return text.slice(prev.end, token.start).includes('\n');
}
