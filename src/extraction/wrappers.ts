import type {
	CallNode,
	Node,
	ObjectNode,
	Prop,
	Question,
	Span,
} from '../types';
import type { Fn } from './functions';

/** A function that builds one question out of its parameters. */
export type Wrapper = Readonly<{
	fn: Fn;
	/** The question it builds, with the parameters still in it as unreadable parts. */
	template: Question;
}>;

// A parameter, as it is or held or converted: `text`, `&text`, `text.into()`, `str(text)`.
const PASSED =
	/^&?(?:str\()?([\p{L}_$][\p{L}\p{N}_$]*)\)?(?:\.(?:into|to_string|to_owned|clone|trim|strip|as_str)\(\))*$/u;

function paramIn(node: Node, text: string): string | undefined {
	if (node.kind !== 'unreadable') return undefined;
	return PASSED.exec(text.slice(node.span.start, node.span.end).trim())?.[1];
}

function leaves(node: Node | undefined): ReadonlyArray<Node> {
	if (!node) return [];
	if (node.kind === 'object')
		return node.props.flatMap((prop) => leaves(prop.value));
	if (node.kind === 'array') return node.items.flatMap(leaves);
	return [node];
}

const within = (inner: Span, outer: Span) =>
	outer.start <= inner.start && inner.end <= outer.end;

/**
 * The functions in a file that build a question from their parameters. Such
 * a function holds no question of its own: each call to it is one.
 */
export function findWrappers(
	text: string,
	functions: ReadonlyMap<string, Fn>,
	questions: ReadonlyArray<Question>,
): ReadonlyMap<string, Wrapper> {
	const wrappers = new Map<string, Wrapper>();
	for (const fn of functions.values()) {
		const inside = questions.filter(
			(question) =>
				question.map === undefined && within(question.span, fn.span),
		);
		// A function that builds two questions cannot be one question at its call.
		const template = inside.length === 1 ? inside[0] : undefined;
		if (!template) continue;
		const parts = [
			...leaves(template.instructions),
			...leaves(template.criteria),
		];
		const takes = parts.some((part) => fn.params.includes(paramIn(part, text)));
		if (takes) wrappers.set(fn.name, { fn, template });
	}
	return wrappers;
}

function argumentFor(call: CallNode, fn: Fn, param: string): Node | undefined {
	const named = call.named?.find((prop) => prop.key === param)?.value;
	return named ?? call.args[fn.params.indexOf(param)];
}

// The template with each parameter replaced by what this call passes for it.
function filled(
	node: Node,
	call: CallNode,
	wrapper: Wrapper,
	text: string,
): Node {
	if (node.kind === 'object') {
		const props = node.props.map((prop) => ({
			...prop,
			value: filled(prop.value, call, wrapper, text),
		}));
		return { ...node, props };
	}
	if (node.kind === 'array') {
		const items = node.items.map((item) => filled(item, call, wrapper, text));
		return { ...node, items };
	}
	const param = paramIn(node, text);
	const passed = param && wrapper.fn.params.includes(param);
	return (passed && argumentFor(call, wrapper.fn, param)) || node;
}

function prop(key: string, value: Node, keySpan: Span): Prop {
	return { key, keySpan, quote: '', value };
}

/** The call as the question it builds, anchored where the call is written. */
function asQuestion(
	call: CallNode,
	wrapper: Wrapper,
	text: string,
): ObjectNode {
	const { template } = wrapper;
	const name = {
		start: call.span.start,
		end: call.span.start + call.callee.length,
	};
	const fields = (['instructions', 'criteria'] as const).flatMap((key) => {
		const value = template[key];
		if (!value) return [];
		const node = filled(value, call, wrapper, text);
		return [prop(key, node, node.span)];
	});
	const type: Node = { kind: 'string', value: template.type, span: name };
	return {
		kind: 'object',
		props: [prop('type', type, name), ...fields],
		// The wrapper may add fields of its own, so the shape is not known in full.
		partial: template.open,
		span: call.span,
	};
}

// A call that only hands on names it was given is one more wrapper, not a question.
function handsOn(call: CallNode, text: string): boolean {
	return (
		call.args.length > 0 &&
		call.args.every((arg) => paramIn(arg, text) !== undefined)
	);
}

/** Replaces each call to a wrapper with the question that call builds. */
export function expandCalls(
	nodes: ReadonlyArray<Node>,
	wrappers: ReadonlyMap<string, Wrapper>,
	text: string,
): ReadonlyArray<Node> {
	const expand = (node: Node): Node => {
		if (node.kind === 'call') {
			const wrapper = wrappers.get(node.callee);
			if (!wrapper || handsOn(node, text))
				return { ...node, args: node.args.map(expand) };
			return asQuestion(node, wrapper, text);
		}
		if (node.kind === 'object') {
			const props = node.props.map((entry) => ({
				...entry,
				value: expand(entry.value),
			}));
			return node.loose
				? { ...node, props, loose: node.loose.map(expand) }
				: { ...node, props };
		}
		if (node.kind === 'array')
			return { ...node, items: node.items.map(expand) };
		if (node.kind === 'unreadable')
			return { ...node, inner: node.inner.map(expand) };
		return node;
	};
	return nodes.map(expand);
}
