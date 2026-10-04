import type { Token, TokenKind } from './tokens';

export type Lexed = Token | undefined;
export type Lexer = (text: string, at: number) => Lexed;

export function token(
	kind: TokenKind,
	text: string,
	start: number,
	end: number,
	quote = '',
): Token {
	return { kind, text, start, end, quote };
}

export function lexPattern(pattern: RegExp, kind: TokenKind): Lexer {
	return (text, at) => {
		pattern.lastIndex = at;
		const match = pattern.exec(text);
		return match ? token(kind, match[0], at, at + match[0].length) : undefined;
	};
}

/** Punctuation, taking the longest of `wide` that matches and one character otherwise. */
export function lexPunct(wide: ReadonlyArray<string>): Lexer {
	return (text, at) => {
		const found = wide.find((mark) => text.startsWith(mark, at));
		const width = found?.length ?? 1;
		return token('punct', text.slice(at, at + width), at, at + width);
	};
}

/** `//` to the end of the line, `/* ... *\/`, or one character of whitespace. */
export function skipSlashTrivia(text: string, at: number): number {
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

/** The index of the closing `quote`, skipping escaped characters, or the end of the text. */
export function closeOf(text: string, from: number, quote: string): number {
	let i = from;
	while (i < text.length && !text.startsWith(quote, i))
		i += text[i] === '\\' ? 2 : 1;
	return Math.min(i, text.length);
}

/** Runs the lexers in order at each position until the text is used up. */
export function tokenizeWith(
	text: string,
	skipTrivia: (text: string, at: number) => number,
	lexers: ReadonlyArray<Lexer>,
): ReadonlyArray<Token> {
	const tokens: Token[] = [];
	let at = 0;
	while (at < text.length) {
		const afterTrivia = skipTrivia(text, at);
		if (afterTrivia > at) {
			at = afterTrivia;
			continue;
		}
		let found: Lexed;
		for (const lexer of lexers) {
			found = lexer(text, at);
			if (found) break;
		}
		if (!found) break;
		tokens.push(found);
		at = found.end;
	}
	return tokens;
}
