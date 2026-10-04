import type { Finding, Question, RuleCode, Span, Syntax } from '../types';

export type CheckContext = Readonly<{
	text: string;
	/** Normalized option names that count as a fallback. */
	fallback: ReadonlySet<string>;
	fallbackName: string;
	/** The language an edit at this position must be written in. */
	syntaxAt: (offset: number) => Syntax;
}>;

export type Check = (
	question: Question,
	context: CheckContext,
) => ReadonlyArray<Finding>;

/**
 * A template slot such as `$options` or `{{question}}`. The real value arrives
 * when the template is filled, so nothing can be said about it here.
 */
export const PLACEHOLDER =
	/^\s*(?:\$\{?[\w.]+\}?|\{\{[^}]*\}\}|%\w+%|<[\w.-]+>)\s*$/;

export const NONE: ReadonlyArray<Finding> = Object.freeze([]);

export function normalizeOption(name: string): string {
	return name.toLowerCase().replace(/[_-]+/g, ' ').trim();
}

export function report(
	code: RuleCode,
	question: Question,
	message: string,
	span: Span = question.anchor,
): Finding {
	return { code, message, span, questionId: question.id, fix: undefined };
}

export function repeated<T>(
	items: ReadonlyArray<T>,
	keyOf: (item: T) => string | undefined,
): ReadonlyArray<T> {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = keyOf(item);
		if (key === undefined) return false;
		if (seen.has(key)) return true;
		seen.add(key);
		return false;
	});
}
