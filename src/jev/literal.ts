import type { Node, Question, QuestionType } from '../types';

/** A question as plain data, the way it would be sent. */
export type QuestionLiteral = Readonly<{
	type: QuestionType;
	instructions: unknown;
	criteria?: unknown;
}>;

const UNREADABLE = Symbol('unreadable');

function toValue(node: Node): unknown {
	// Text with slots is not what would be sent, so Jev is not shown it.
	if (node.kind === 'string') return node.slots ? UNREADABLE : node.value;
	if (node.kind === 'number') return node.value;
	if (node.kind === 'boolean') return node.value;
	if (node.kind === 'null') return null;
	if (node.kind === 'array' && !node.partial) return node.items.map(toValue);
	if (node.kind === 'object' && !node.partial) {
		return Object.fromEntries(
			node.props.map((prop) => [prop.key, toValue(prop.value)]),
		);
	}
	return UNREADABLE;
}

function holdsUnreadable(value: unknown): boolean {
	if (value === UNREADABLE) return true;
	if (Array.isArray(value)) return value.some(holdsUnreadable);
	if (value && typeof value === 'object') {
		return Object.values(value).some(holdsUnreadable);
	}
	return false;
}

/** A literal as plain data, or undefined when any part of it is built at runtime. */
export function toPlain(node: Node): unknown | undefined {
	const value = toValue(node);
	return holdsUnreadable(value) ? undefined : value;
}

/**
 * The question as data, or undefined when any part of it is built at runtime.
 * Jev is only ever shown a question exactly as written, never one with holes.
 */
export function toLiteral(question: Question): QuestionLiteral | undefined {
	if (!question.instructions) return undefined;
	const instructions = toValue(question.instructions);
	const criteria = question.criteria ? toValue(question.criteria) : undefined;
	if (holdsUnreadable(instructions) || holdsUnreadable(criteria))
		return undefined;
	return criteria === undefined
		? { type: question.type, instructions }
		: { type: question.type, instructions, criteria };
}
