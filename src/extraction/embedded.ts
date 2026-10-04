import type { Node, Span } from '../types';
import { readNodes } from './reader';
import type { Token } from './tokens';

export type Embedded = Readonly<{
	nodes: ReadonlyArray<Node>;
	/** The strings that were read as JSON. Inside one, an edit is written as JSON whatever the file is. */
	regions: ReadonlyArray<Span>;
}>;

// A request or a question pasted into a string: it opens with a brace and names one of these.
const LOOKS_LIKE_JSON = /^\s*\{[\s\S]*"(?:questions|instructions|criteria)"/;

function shift(span: Span, by: number): Span {
	return { start: span.start + by, end: span.end + by };
}

function moved(node: Node, by: number): Node {
	const span = shift(node.span, by);
	if (node.kind === 'object') {
		return {
			...node,
			span,
			props: node.props.map((prop) => ({
				...prop,
				keySpan: shift(prop.keySpan, by),
				value: moved(prop.value, by),
			})),
		};
	}
	if (node.kind === 'array')
		return { ...node, span, items: node.items.map((item) => moved(item, by)) };
	if (node.kind === 'call')
		return { ...node, span, args: node.args.map((arg) => moved(arg, by)) };
	if (node.kind === 'unreadable')
		return {
			...node,
			span,
			inner: node.inner.map((inner) => moved(inner, by)),
		};
	return { ...node, span };
}

/**
 * JSON written inside a string literal, in any language. Only a string whose
 * source is its value character for character is read, so every position
 * inside it maps straight back to the file. A string with an escape in it
 * does not qualify and is left alone.
 */
export function readEmbedded(
	text: string,
	tokens: ReadonlyArray<Token>,
): Embedded {
	const nodes: Node[] = [];
	const regions: Span[] = [];
	for (const token of tokens) {
		if (token.kind !== 'string' || !LOOKS_LIKE_JSON.test(token.text)) continue;
		const body = text.slice(token.start, token.end).indexOf(token.text);
		if (body === -1) continue;
		const found = readNodes(token.text).filter(
			(node) => node.kind === 'object',
		);
		if (!found.length) continue;
		const offset = token.start + body;
		nodes.push(...found.map((node) => moved(node, offset)));
		regions.push({ start: token.start, end: token.end });
	}
	return { nodes, regions };
}
