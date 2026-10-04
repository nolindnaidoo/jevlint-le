import type { Span } from '../types';
import type { Token } from './tokens';

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const DELIMITERS = new Set([',', ')', ']', '}']);

export function isPunct(token: Token | undefined, text: string): boolean {
	return token?.kind === 'punct' && token.text === text;
}

export function spanOf(token: Token): Span {
	return { start: token.start, end: token.end };
}

function depthChange(token: Token): number {
	if (token.kind !== 'punct') return 0;
	if (OPENERS.has(token.text)) return 1;
	return CLOSERS.has(token.text) ? -1 : 0;
}

/** The index of the first delimiter at depth zero, at or after `at`. */
export function skipExpression(
	tokens: ReadonlyArray<Token>,
	at: number,
): number {
	let depth = 0;
	let i = at;
	while (i < tokens.length) {
		const token = tokens[i] as Token;
		if (depth === 0 && token.kind === 'punct' && DELIMITERS.has(token.text))
			return i;
		depth += depthChange(token);
		i += 1;
	}
	return i;
}

/** The index just past the closer matching the opener at `at`. */
export function skipBalanced(tokens: ReadonlyArray<Token>, at: number): number {
	let depth = 0;
	let i = at;
	while (i < tokens.length) {
		depth += depthChange(tokens[i] as Token);
		i += 1;
		if (depth <= 0) return i;
	}
	return i;
}
