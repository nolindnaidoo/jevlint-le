import type { Token, TokenKind } from './tokens';

type Lexed = Token | undefined;

const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUMBER =
	/0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?/y;
const STRING_OPEN = /([rRbBuUfF]{0,2})('''|"""|'|")/y;
const ESCAPE =
	/\\(U[\da-fA-F]{8}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[0-7]{1,3}|\r\n|[\s\S])/g;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	v: '\v',
	a: '\x07',
	'\\': '\\',
	"'": "'",
	'"': '"',
	'\n': '',
	'\r\n': '',
});

function decodeEscape(match: string, body: string): string {
	const simple = SIMPLE_ESCAPES[body];
	if (simple !== undefined) return simple;
	if (/^[uUx]/.test(body))
		return String.fromCodePoint(Number.parseInt(body.slice(1), 16));
	if (/^[0-7]/.test(body))
		return String.fromCodePoint(Number.parseInt(body, 8));
	// Python keeps the backslash of an escape it does not know, such as `\d`.
	return match;
}

function skipTrivia(text: string, at: number): number {
	const ch = text[at] ?? '';
	if (ch === '#') {
		const eol = text.indexOf('\n', at);
		return eol === -1 ? text.length : eol;
	}
	// A backslash before a newline joins two lines and means nothing else.
	if (ch === '\\' && /^\\\r?\n/.test(text.slice(at, at + 3)))
		return text.indexOf('\n', at) + 1;
	return /\s/.test(ch) ? at + 1 : at;
}

/** The index of the closing quote, or of where an unterminated string stops. */
function closeOf(text: string, from: number, quote: string): number {
	let i = from;
	while (i < text.length) {
		if (text.startsWith(quote, i)) return i;
		if (quote.length === 1 && text[i] === '\n') return i;
		i += text[i] === '\\' ? 2 : 1;
	}
	return text.length;
}

// What a string literal holds, or undefined when its value is not known here:
// bytes are not text, and an f-string with a `{}` slot is filled at runtime.
function stringValue(prefix: string, raw: string): string | undefined {
	if (prefix.includes('b')) return undefined;
	const formatted = prefix.includes('f');
	if (formatted && raw.replace(/\{\{|\}\}/g, '').includes('{'))
		return undefined;
	const decoded = prefix.includes('r')
		? raw
		: raw.replace(ESCAPE, decodeEscape);
	return formatted
		? decoded.replace(/\{\{/g, '{').replace(/\}\}/g, '}')
		: decoded;
}

function lexString(text: string, at: number): Lexed {
	STRING_OPEN.lastIndex = at;
	const open = STRING_OPEN.exec(text);
	if (!open) return undefined;
	const quote = open[2] as string;
	const bodyStart = at + open[0].length;
	const close = closeOf(text, bodyStart, quote);
	const end = text.startsWith(quote, close) ? close + quote.length : close;
	const value = stringValue(
		(open[1] ?? '').toLowerCase(),
		text.slice(bodyStart, close),
	);
	if (value === undefined) {
		return {
			kind: 'template',
			text: text.slice(at, end),
			start: at,
			end,
			quote: '',
		};
	}
	return { kind: 'string', text: value, start: at, end, quote };
}

function lexPattern(pattern: RegExp, kind: TokenKind) {
	return (text: string, at: number): Lexed => {
		pattern.lastIndex = at;
		const match = pattern.exec(text);
		if (!match) return undefined;
		return {
			kind,
			text: match[0],
			start: at,
			end: at + match[0].length,
			quote: '',
		};
	};
}

function lexPunct(text: string, at: number): Token {
	const width = text.startsWith('**', at) ? 2 : 1;
	return {
		kind: 'punct',
		text: text.slice(at, at + width),
		start: at,
		end: at + width,
		quote: '',
	};
}

const lexNumber = lexPattern(NUMBER, 'number');
const lexIdent = lexPattern(IDENT, 'ident');

/**
 * Splits Python into the same tokens the JavaScript lexer produces, so the
 * reader above it can find dict literals without being fooled by braces in
 * strings, comments and f-strings. Indentation carries no meaning here: a
 * literal is the same wherever it sits.
 */
export function tokenizePython(text: string): ReadonlyArray<Token> {
	const tokens: Token[] = [];
	let at = 0;
	while (at < text.length) {
		const afterTrivia = skipTrivia(text, at);
		if (afterTrivia > at) {
			at = afterTrivia;
			continue;
		}
		const token =
			lexString(text, at) ??
			lexNumber(text, at) ??
			lexIdent(text, at) ??
			lexPunct(text, at);
		tokens.push(token);
		at = token.end;
	}
	return tokens;
}
