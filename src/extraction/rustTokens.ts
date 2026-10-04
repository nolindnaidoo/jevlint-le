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

// `r#type` is the identifier `type`, written so because `type` is a keyword.
const IDENT = /(?:r#)?[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER =
	/0[xX][\da-fA-F_]+\w*|0[bB][01_]+\w*|0[oO][0-7_]+\w*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?(?:[iuf]\d+|[iu]size)?/y;
const RAW_OPEN = /(b?)r(#*)"/y;
const CHAR = /b?'(?:\\(?:u\{[^}]*\}|x[\da-fA-F]{2}|[\s\S])|[^'\\\n])'/y;
const ESCAPE = /\\(u\{[\da-fA-F_]+\}|x[\da-fA-F]{2}|\r?\n\s*|[\s\S])/g;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
	n: '\n',
	t: '\t',
	r: '\r',
	'0': '\0',
	'\\': '\\',
	"'": "'",
	'"': '"',
});

function decodeEscape(match: string, body: string): string {
	const simple = SIMPLE_ESCAPES[body];
	if (simple !== undefined) return simple;
	if (body.startsWith('u{'))
		return String.fromCodePoint(
			Number.parseInt(body.slice(2, -1).replace(/_/g, ''), 16),
		);
	if (body.startsWith('x'))
		return String.fromCharCode(Number.parseInt(body.slice(1), 16));
	// A backslash at the end of a line joins it to the next and drops the indent.
	return /^\r?\n/.test(body) ? '' : match;
}

function lexRawString(text: string, at: number): Lexed {
	RAW_OPEN.lastIndex = at;
	const open = RAW_OPEN.exec(text);
	if (!open) return undefined;
	const closer = `"${open[2] ?? ''}`;
	const bodyStart = at + open[0].length;
	const found = text.indexOf(closer, bodyStart);
	const close = found === -1 ? text.length : found;
	const end = Math.min(text.length, close + closer.length);
	// Bytes are not text Jev would be sent as a question.
	if (open[1]) return token('template', text.slice(at, end), at, end);
	return token('string', text.slice(bodyStart, close), at, end, '"');
}

function lexString(text: string, at: number): Lexed {
	const bytes = text.startsWith('b"', at);
	if (text[at] !== '"' && !bytes) return undefined;
	const bodyStart = at + (bytes ? 2 : 1);
	const close = closeOf(text, bodyStart, '"');
	const end = Math.min(text.length, close + 1);
	if (bytes) return token('template', text.slice(at, end), at, end);
	const value = text.slice(bodyStart, close).replace(ESCAPE, decodeEscape);
	return token('string', value, at, end, '"');
}

// 'a' is a character. 'a with no closing quote is a lifetime, left as punctuation and a name.
const lexChar = lexPattern(CHAR, 'template');

function lexIdent(text: string, at: number): Lexed {
	IDENT.lastIndex = at;
	const match = IDENT.exec(text);
	if (!match) return undefined;
	return token('ident', match[0].replace(/^r#/, ''), at, at + match[0].length);
}

/** Splits Rust into the tokens the readers share. */
export function tokenizeRust(text: string): ReadonlyArray<Token> {
	return tokenizeWith(text, skipSlashTrivia, [
		lexRawString,
		lexString,
		lexChar,
		lexPattern(NUMBER, 'number'),
		lexIdent,
		lexPunct(['::', '..=', '..', '=>', '->']),
	]);
}
