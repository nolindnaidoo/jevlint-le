import type { Finding, Span } from '../types';

type Directive = Readonly<{
	/** The line the directive silences, or undefined for the whole file. */
	line: number | undefined;
	/** Empty means every rule. */
	codes: ReadonlySet<string>;
	/** The directive's own text, to point at when it silences nothing. */
	span: Span;
}>;

export type UnusedDirective = Readonly<{
	span: Span;
	/** True when it names no rule, and so silences every one. */
	bare: boolean;
}>;

export type Suppression = Readonly<{
	/** True for a finding a comment silences. Asking also records which comment did. */
	isSuppressed: (finding: Finding) => boolean;
	/**
	 * The comments that have silenced nothing so far. One that names only
	 * Jev-backed rules is left out: linting never runs those, so it cannot tell.
	 */
	unused: () => ReadonlyArray<UnusedDirective>;
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
		return {
			line,
			codes: new Set((match[2] ?? '').match(CODE) ?? []),
			span: {
				start: match.index,
				end: match.index + match[0].trimEnd().length,
			},
		};
	});
}

function silences(directive: Directive, code: string, line: number): boolean {
	if (directive.line !== undefined && directive.line !== line) return false;
	return directive.codes.size === 0 || directive.codes.has(code);
}

const NONE: Suppression = Object.freeze({
	isSuppressed: () => false,
	unused: () => [],
});

const onlyJevBacked = (directive: Directive): boolean =>
	directive.codes.size > 0 &&
	[...directive.codes].every((code) => code.startsWith('JEV3'));

/**
 * The comment directives in a text: `jevlint-le-disable-next-line JEV004`,
 * `jevlint-le-disable-line`, or `jevlint-le-disable` for the whole file. No
 * code list means every rule.
 */
export function suppression(text: string): Suppression {
	if (!text.includes('jevlint-le-disable')) return NONE;
	const starts = lineStarts(text);
	const found = directives(text, starts);
	const used = new Set<Directive>();
	return {
		isSuppressed: (finding: Finding) => {
			const line = lineAt(starts, finding.span.start);
			const silencing = found.filter((directive) =>
				silences(directive, finding.code, line),
			);
			for (const directive of silencing) used.add(directive);
			return silencing.length > 0;
		},
		unused: () =>
			found
				.filter(
					(directive) => !used.has(directive) && !onlyJevBacked(directive),
				)
				.map((directive) => ({
					span: directive.span,
					bare: directive.codes.size === 0,
				})),
	};
}

/** A predicate that is true for findings silenced by a comment directive. */
export function suppressor(text: string): (finding: Finding) => boolean {
	return suppression(text).isSuppressed;
}
