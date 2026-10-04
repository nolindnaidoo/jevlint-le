import type { Span, StringNode } from '../types';
import { isPunct, skipBalanced } from './cursor';
import type { Token } from './tokens';

/**
 * What stands where a runtime value goes. It is written in backticks because
 * the wording rules already set backticked text aside as data.
 */
export const SLOT = '`…`';

export function slotted(value: string, span: Span): StringNode {
	return { kind: 'string', value, span, slots: true };
}

/** `{name}` and `{}` as slots, and `{{` as a brace: Python f-strings, `str.format` and Rust's `format!`. */
export function fillBraces(text: string): string {
	return text.replace(/\{\{|\}\}|\{[^{}]*\}/g, (match) => {
		if (match === '{{') return '{';
		return match === '}}' ? '}' : SLOT;
	});
}

/** `%s`, `%d` and `%v` as slots, and `%%` as a percent sign: Go's `Sprintf`. */
export function fillVerbs(text: string): string {
	return text.replace(/%%|%[-+# 0]*\d*(?:\.\d+)?[a-zA-Z]/g, (match) =>
		match === '%%' ? '%' : SLOT,
	);
}

/** `${...}` as a slot, in the source of a JavaScript template between its backticks. */
export function fillSubstitutions(source: string): string {
	let out = '';
	let i = 0;
	while (i < source.length) {
		if (source[i] === '\\') {
			out += source.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (source.startsWith('${', i)) {
			out += SLOT;
			i = closeOfSubstitution(source, i + 2);
			continue;
		}
		out += source[i];
		i += 1;
	}
	return out;
}

// The index past the `}` that closes a `${`, counting braces inside it.
function closeOfSubstitution(source: string, from: number): number {
	let depth = 1;
	let i = from;
	while (i < source.length && depth > 0) {
		if (source[i] === '{') depth += 1;
		if (source[i] === '}') depth -= 1;
		i += 1;
	}
	return i;
}

/**
 * `"Is " + name + " late?"` as its fixed text with a slot for each part that
 * is not a string. Undefined unless at least one part is, so `a + b` stays a
 * sum. `textOf` gives the text of a part that is a single token.
 */
export function readJoined(
	tokens: ReadonlyArray<Token>,
	at: number,
	end: number,
	textOf: (token: Token) => string | undefined,
): StringNode | undefined {
	const parts: string[] = [];
	let fixed = 0;
	let i = at;
	while (i < end) {
		let stop = i;
		while (stop < end && !isPunct(tokens[stop], '+')) {
			const opens =
				tokens[stop]?.kind === 'punct' &&
				['(', '[', '{'].includes((tokens[stop] as Token).text);
			stop = opens ? skipBalanced(tokens, stop) : stop + 1;
		}
		const text = stop === i + 1 ? textOf(tokens[i] as Token) : undefined;
		if (text !== undefined) fixed += 1;
		parts.push(text ?? SLOT);
		i = stop + 1;
	}
	const first = tokens[at];
	const last = tokens[end - 1];
	if (!fixed || parts.length < 2 || !first || !last) return undefined;
	return slotted(parts.join(''), { start: first.start, end: last.end });
}
