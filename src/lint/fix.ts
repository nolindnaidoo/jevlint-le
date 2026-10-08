import type {
	ArrayNode,
	Fix,
	Node,
	ObjectNode,
	Prop,
	Span,
	Syntax,
} from '../types';
import { KNOWN_VERSION, VERIFIED_ON } from './limits';

const DESCRIPTION = 'Fits none of the other options';

function entryText(name: string, last: Prop, syntax: Syntax): string {
	if (last.quote === '"') return `"${name}": "${DESCRIPTION}"`;
	// A bare word is a key in JavaScript and a variable in Python.
	if (syntax === 'python') return `'${name}': '${DESCRIPTION}'`;
	const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
	return `${key}: '${DESCRIPTION}'`;
}

function indentOf(text: string, offset: number): string | undefined {
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const lead = text.slice(lineStart, offset);
	return /^\s*$/.test(lead) ? lead : undefined;
}

/**
 * The edit that appends a fallback option to a Choice. Returns undefined
 * wherever the text after the last option is anything but whitespace and an
 * optional comma, because an edit built on a guess about a comment or a type
 * assertion would corrupt the file.
 */
export function fallbackFix(
	options: ObjectNode,
	text: string,
	name: string,
	syntax: Syntax = 'js',
): Fix | undefined {
	const last = options.props[options.props.length - 1];
	if (!last) return undefined;
	const valueEnd = last.value.span.end;
	const tail = text.slice(valueEnd, options.span.end - 1);
	if (!/^\s*,?\s*$/.test(tail)) return undefined;

	const comma = tail.indexOf(',');
	const trailing = comma !== -1;
	const at = trailing ? valueEnd + comma + 1 : valueEnd;
	const entry = entryText(name, last, syntax);
	const indent = indentOf(text, last.keySpan.start);
	const lead = indent === undefined ? ' ' : `\n${indent}`;
	const inserted = trailing ? `${lead}${entry},` : `,${lead}${entry}`;
	return {
		title: `Add ${/^[aeiou]/i.test(name) ? 'an' : 'a'} '${name}' option`,
		edits: [{ span: { start: at, end: at }, text: inserted }],
		// A new option is a new answer the caller's code has to be ready for.
		safe: false,
	};
}

const replace = (
	title: string,
	span: Span,
	text: string,
	safe = true,
): Fix => ({
	title,
	edits: [{ span, text }],
	safe,
});

// A string literal's own quote, so the edit matches the file around it.
function requote(text: string, span: Span, value: string): string {
	const first = text[span.start] ?? '';
	// A Python string can open with a prefix letter, which the new value does not need.
	const quote = first === "'" || first === '`' ? first : '"';
	return `${quote}${value}${quote}`;
}

/** Renames one key, keeping whatever quotes it was written with. */
export function renameKeyFix(prop: Prop, name: string): Fix {
	return replace(
		`Rename '${prop.key}' to '${name}'`,
		prop.keySpan,
		`${prop.quote}${name}${prop.quote}`,
	);
}

/**
 * Pins an alias to the newest version this extension has been checked
 * against. The title carries the date, because that version stops being the
 * newest and the edit cannot know when.
 */
export function pinModelFix(text: string, span: Span): Fix {
	return replace(
		`Pin to '${KNOWN_VERSION}', the version current on ${VERIFIED_ON}`,
		span,
		requote(text, span, KNOWN_VERSION),
		// Which version to pin is a choice, and this one goes stale.
		false,
	);
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i += 1) {
		let diagonal = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const above = row[j] as number;
			const swap = diagonal + (a[i - 1] === b[j - 1] ? 0 : 1);
			row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, swap);
			diagonal = above;
		}
	}
	return row[b.length] as number;
}

/** The fix for a mistyped question type, offered only when one real type is within two edits. */
export function nearestTypeFix(
	text: string,
	span: Span,
	found: string,
): Fix | undefined {
	const near = ['noul', 'choice', 'score'].filter(
		(type) => distance(found.toLowerCase(), type) <= 2,
	);
	if (near.length !== 1) return undefined;
	const type = near[0] as string;
	return replace(`Change to '${type}'`, span, requote(text, span, type));
}

function sourceOf(text: string, node: Node): string {
	return text.slice(node.span.start, node.span.end);
}

// One entry per line when the original was laid out that way, at its indent.
function relist(
	text: string,
	container: ObjectNode | ArrayNode,
	first: Span | undefined,
	entries: ReadonlyArray<string>,
	brackets: readonly [string, string],
): string {
	const [open, close] = brackets;
	const indent = first ? indentOf(text, first.start) : undefined;
	if (indent === undefined) {
		const pad = open === '{' ? ' ' : '';
		return `${open}${pad}${entries.join(', ')}${pad}${close}`;
	}
	const closing = indentOf(text, container.span.end - 1) ?? '';
	const lines = entries.map((entry) => `${indent}${entry}`).join(',\n');
	return `${open}\n${lines}\n${closing}${close}`;
}

/**
 * A Score written as a map, turned into the ordered array the API wants. The
 * descriptions are kept word for word and the keys are dropped, which loses
 * nothing Jev would have seen. Offered only when every value could be read.
 */
export function scoreArrayFix(
	text: string,
	criteria: ObjectNode,
): Fix | undefined {
	if (criteria.partial || !criteria.props.length) return undefined;
	if (criteria.props.some((prop) => prop.value.kind === 'unreadable')) {
		return undefined;
	}
	const levels = criteria.props.map((prop) => sourceOf(text, prop.value));
	return replace(
		'Turn the levels into an ordered array',
		criteria.span,
		relist(text, criteria, criteria.props[0]?.keySpan, levels, ['[', ']']),
	);
}

/**
 * A Choice written as an array of names, turned into the map the API wants,
 * each option with no description yet. Offered only for an array of strings.
 * `at` is what the map replaces: the array itself, or the one-option map the
 * array was wrapped in, which the API accepts and so is never safe to mend.
 */
export function choiceMapFix(
	text: string,
	criteria: ArrayNode,
	syntax: Syntax = 'js',
	at: Span = criteria.span,
): Fix | undefined {
	if (criteria.partial || !criteria.items.length) return undefined;
	if (!criteria.items.every((item) => item.kind === 'string')) return undefined;
	const options = criteria.items.map(
		(item) =>
			`${sourceOf(text, item)}: ${syntax === 'python' ? 'None' : 'null'}`,
	);
	return replace(
		'Turn the options into a map',
		at,
		relist(text, criteria, criteria.items[0]?.span, options, ['{', '}']),
		at === criteria.span,
	);
}
