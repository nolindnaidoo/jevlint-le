import type { Finding } from '../types';

type Directive = Readonly<{
	/** The line the directive silences, or undefined for the whole file. */
	line: number | undefined;
	/** Empty means every rule. */
	codes: ReadonlySet<string>;
}>;

const DIRECTIVE = /jevlint-le-disable(-next-line|-line)?\b([^\n]*)/g;
const CODE = /JEV\d{3}/g;
const LINE_OFFSETS: Readonly<Record<string, number | undefined>> =
	Object.freeze({
		'-next-line': 1,
		'-line': 0,
	});

function lineStarts(text: string): ReadonlyArray<number> {
	const starts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1))
		starts.push(i + 1);
	return starts;
}

function lineAt(starts: ReadonlyArray<number>, offset: number): number {
	let low = 0;
	let high = starts.length - 1;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if ((starts[mid] as number) <= offset) low = mid;
		if ((starts[mid] as number) > offset) high = mid - 1;
	}
	return low;
}

function directives(
	text: string,
	starts: ReadonlyArray<number>,
): ReadonlyArray<Directive> {
	return [...text.matchAll(DIRECTIVE)].map((match) => {
		const offset = LINE_OFFSETS[match[1] ?? ''];
		const line =
			offset === undefined ? undefined : lineAt(starts, match.index) + offset;
		return { line, codes: new Set((match[2] ?? '').match(CODE) ?? []) };
	});
}

function silences(directive: Directive, code: string, line: number): boolean {
	if (directive.line !== undefined && directive.line !== line) return false;
	return directive.codes.size === 0 || directive.codes.has(code);
}

/**
 * A predicate that is true for findings silenced by a comment directive:
 * `jevlint-le-disable-next-line JEV004`, `jevlint-le-disable-line`, or
 * `jevlint-le-disable` for the whole file. No code list means every rule.
 */
export function suppressor(text: string): (finding: Finding) => boolean {
	if (!text.includes('jevlint-le-disable')) return () => false;
	const starts = lineStarts(text);
	const found = directives(text, starts);
	return (finding: Finding) => {
		const line = lineAt(starts, finding.span.start);
		return found.some((directive) => silences(directive, finding.code, line));
	};
}
