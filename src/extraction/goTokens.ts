import {
	closeOf,
	type Lexed,
	lexPattern,
	lexPunct,
	skipSlashTrivia,
	token,
	tokenizeWith,
} from './lexKit';
import type { Token } from './tokens';

const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER =
	/0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO]?[0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?i?/y;
const RUNE = /'(?:\\[\s\S][^']*|[^'\\\n])'/y;
const ESCAPE =
	/\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[0-7]{3}|[\s\S])/g;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
	n: '\n',
	t: '\t',
	r: '\r',
	a: '\x07',
	b: '\b',
	f: '\f',
	v: '\v',
	'\\': '\\',
	"'": "'",
	'"': '"',
});

function decodeEscape(match: string, body: string): string {
	const simple = SIMPLE_ESCAPES[body];
	if (simple !== undefined) return simple;
	if (/^[uUx]/.test(body))
		return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
	return /^[0-7]{3}$/.test(body)
		? String.fromCodePoint(Number.parseInt(body, 8))
		: match;
}

function lexString(text: string, at: number): Lexed {
	const quote = text[at];
	if (quote !== '"' && quote !== '`') return undefined;
	// A raw string runs to the next backtick, newlines and backslashes included.
	const raw = quote === '`';
	const found = raw ? text.indexOf('`', at + 1) : closeOf(text, at + 1, '"');
	const close = found === -1 ? text.length : found;
	const end = Math.min(text.length, close + 1);
	const body = text.slice(at + 1, close);
	return token(
		'string',
		raw ? body : body.replace(ESCAPE, decodeEscape),
		at,
		end,
		quote,
	);
}

/** Splits Go into the tokens the readers share. */
export function tokenizeGo(text: string): ReadonlyArray<Token> {
	return tokenizeWith(text, skipSlashTrivia, [
		lexString,
		lexPattern(RUNE, 'template'),
		lexPattern(NUMBER, 'number'),
		lexPattern(IDENT, 'ident'),
		lexPunct([':=', '...']),
	]);
}
