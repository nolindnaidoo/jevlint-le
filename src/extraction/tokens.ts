export type TokenKind =
	| 'punct'
	| 'ident'
	| 'string'
	| 'number'
	| 'template'
	| 'regex';

export type Token = Readonly<{
	kind: TokenKind;
	/** Decoded value for a string, source text for everything else. */
	text: string;
	start: number;
	end: number;
	/** The delimiter of a string token, '' otherwise. */
	quote: string;
}>;

type Lexed = Token | undefined;

const IDENT = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
const NUMBER =
	/0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?n?/y;
const ESCAPE =
	/\\(u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|\r\n|[\s\S])/g;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	v: '\v',
	'0': '\0',
	'\n': '',
	'\r\n': '',
});

// After one of these a `/` divides. After anything else it opens a regex.
const VALUE_END_PUNCT = new Set([')', ']', '}']);
const REGEX_ALLOWED_AFTER_IDENT = new Set([
	'return',
	'typeof',
	'case',
	'in',
	'of',
	'delete',
	'void',
	'throw',
	'new',
	'else',
	'do',
	'instanceof',
	'yield',
	'await',
]);

function decodeEscape(_match: string, body: string): string {
	const simple = SIMPLE_ESCAPES[body];
	if (simple !== undefined) return simple;
	if (body.startsWith('u{'))
		return String.fromCodePoint(Number.parseInt(body.slice(2, -1), 16));
	if (/^[ux][\da-fA-F]/.test(body))
		return String.fromCharCode(Number.parseInt(body.slice(1), 16));
	return body;
}

export function decode(raw: string): string {
	return raw.replace(ESCAPE, decodeEscape);
}

function skipTrivia(text: string, at: number): number {
	const two = text.slice(at, at + 2);
	if (two === '//') {
		const eol = text.indexOf('\n', at);
		return eol === -1 ? text.length : eol;
	}
	if (two === '/*') {
		const close = text.indexOf('*/', at + 2);
		return close === -1 ? text.length : close + 2;
	}
	return /\s/.test(text[at] ?? '') ? at + 1 : at;
}

function lexString(text: string, at: number): Lexed {
	const quote = text[at];
	if (quote !== '"' && quote !== "'") return undefined;
	let i = at + 1;
	while (i < text.length && text[i] !== quote && text[i] !== '\n') {
		i += text[i] === '\\' ? 2 : 1;
	}
	// An unterminated string ends at the newline. Its value is still what was written.
	const end = text[i] === quote ? i + 1 : i;
	return {
		kind: 'string',
		text: decode(text.slice(at + 1, i)),
		start: at,
		end,
		quote,
	};
}

/** The index just past the `}` that closes a `${` opened before `at`. */
function skipSubstitution(text: string, at: number): number {
	let depth = 1;
	let i = at;
	while (i < text.length && depth > 0) {
		const ch = text[i];
		const nested = ch === '`' ? lexTemplate(text, i) : lexString(text, i);
		if (nested) {
			i = nested.end;
			continue;
		}
		if (ch === '{') depth += 1;
		if (ch === '}') depth -= 1;
		i += 1;
	}
	return i;
}

function lexTemplate(text: string, at: number): Lexed {
	if (text[at] !== '`') return undefined;
	let i = at + 1;
	let substituted = false;
	while (i < text.length && text[i] !== '`') {
		if (text[i] === '\\') {
			i += 2;
			continue;
		}
		if (text[i] === '$' && text[i + 1] === '{') {
			substituted = true;
			i = skipSubstitution(text, i + 2);
			continue;
		}
		i += 1;
	}
	const end = Math.min(i + 1, text.length);
	if (substituted)
		return {
			kind: 'template',
			text: text.slice(at, end),
			start: at,
			end,
			quote: '',
		};
	return {
		kind: 'string',
		text: decode(text.slice(at + 1, i)),
		start: at,
		end,
		quote: '`',
	};
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

function regexMayStart(prev: Token | undefined): boolean {
	if (!prev) return true;
	if (prev.kind === 'ident') return REGEX_ALLOWED_AFTER_IDENT.has(prev.text);
	if (prev.kind === 'punct') return !VALUE_END_PUNCT.has(prev.text);
	return false;
}

function lexRegex(text: string, at: number, prev: Token | undefined): Lexed {
	if (text[at] !== '/' || !regexMayStart(prev)) return undefined;
	let i = at + 1;
	let inClass = false;
	while (i < text.length && text[i] !== '\n') {
		const ch = text[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '/' && !inClass) break;
		if (ch === '[') inClass = true;
		if (ch === ']') inClass = false;
		i += 1;
	}
	// No closing slash on the line: this was a division after all.
	if (text[i] !== '/') return undefined;
	const flags = /[a-z]*/y;
	flags.lastIndex = i + 1;
	const end = i + 1 + (flags.exec(text)?.[0].length ?? 0);
	return {
		kind: 'regex',
		text: text.slice(at, end),
		start: at,
		end,
		quote: '',
	};
}

function lexPunct(text: string, at: number): Token {
	const width = text.startsWith('...', at) ? 3 : 1;
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

function lexOne(text: string, at: number, prev: Token | undefined): Token {
	return (
		lexString(text, at) ??
		lexTemplate(text, at) ??
		lexNumber(text, at) ??
		lexIdent(text, at) ??
		lexRegex(text, at, prev) ??
		lexPunct(text, at)
	);
}

/**
 * Splits JavaScript, TypeScript, JSON or JSONC into tokens. It is a lexer and
 * not a parser: it exists so the reader can find object literals without
 * being fooled by braces inside strings, comments, templates and regexes.
 */
export function tokenize(text: string): ReadonlyArray<Token> {
	const tokens: Token[] = [];
	let at = 0;
	while (at < text.length) {
		const afterTrivia = skipTrivia(text, at);
		if (afterTrivia > at) {
			at = afterTrivia;
			continue;
		}
		const token = lexOne(text, at, tokens[tokens.length - 1]);
		tokens.push(token);
		at = token.end;
	}
	return tokens;
}
