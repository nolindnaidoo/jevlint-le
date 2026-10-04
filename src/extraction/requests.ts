import type {
	ArrayNode,
	CallNode,
	Extraction,
	Malformed,
	ModelRef,
	Node,
	ObjectNode,
	Prop,
	Question,
	QuestionMap,
	QuestionType,
	Span,
} from '../types';

type Sink = {
	readonly questions: Question[];
	readonly maps: QuestionMap[];
	readonly malformed: Malformed[];
	readonly models: ModelRef[];
	/** The helper names this file imports from the SDK. A `choice(...)` not in here is someone else's function. */
	readonly trusted: ReadonlySet<string>;
};

type Named = Readonly<{ id: string; span: Span }> | undefined;

const TYPES: ReadonlySet<string> = new Set(['noul', 'choice', 'score']);
// The Vercel AI SDK's evaluate API names the yes/no type `boolean`.
const TYPE_ALIASES: Readonly<Record<string, QuestionType>> = Object.freeze({
	boolean: 'noul',
});
// Field names other clients and older payloads use for the same things.
const FOREIGN_FIELDS: ReadonlySet<string> = new Set([
	'prompt',
	'options',
	'legend',
	'rubric',
	'levels',
	'choices',
	'labels',
	'descriptions',
	'answer',
	'probabilities',
]);
const OXLINT_RULE = 'jev/ask';

function prop(node: ObjectNode, key: string): Prop | undefined {
	return node.props.find((candidate) => candidate.key === key);
}

function hasBody(node: ObjectNode): boolean {
	return Boolean(prop(node, 'instructions') ?? prop(node, 'criteria'));
}

function typeOf(node: ObjectNode): QuestionType | undefined {
	const type = prop(node, 'type')?.value;
	if (type?.kind !== 'string') return undefined;
	const alias = TYPE_ALIASES[type.value];
	if (alias) return alias;
	return TYPES.has(type.value) ? (type.value as QuestionType) : undefined;
}

function isQuestionObject(node: Node): boolean {
	return node.kind === 'object' && typeOf(node) !== undefined && hasBody(node);
}

function isHelper(node: Node, sink: Sink): node is CallNode {
	return node.kind === 'call' && sink.trusted.has(node.callee);
}

function fromObject(
	node: ObjectNode,
	named: Named,
	inRequest: boolean,
	map?: number,
): Question {
	const typeProp = prop(node, 'type') as Prop;
	return {
		id: named?.id,
		anchor: named?.span ?? typeProp.value.span,
		span: node.span,
		type: typeOf(node) as QuestionType,
		instructions: prop(node, 'instructions')?.value,
		criteria: prop(node, 'criteria')?.value,
		criteriaKey: prop(node, 'criteria')?.keySpan,
		open:
			node.partial || node.props.some((entry) => FOREIGN_FIELDS.has(entry.key)),
		inRequest,
		map,
	};
}

function fromCall(node: CallNode, named: Named, map?: number): Question {
	const calleeSpan = {
		start: node.span.start,
		end: node.span.start + node.callee.length,
	};
	return {
		id: named?.id,
		anchor: named?.span ?? calleeSpan,
		span: node.span,
		type: node.callee as QuestionType,
		instructions: node.args[0],
		criteria: node.args[1],
		criteriaKey: undefined,
		open: false,
		inRequest: true,
		map,
	};
}

function describeMalformed(
	value: Node,
): Readonly<{ reason: Malformed['reason']; found: string }> | undefined {
	if (value.kind !== 'object') return { reason: 'runtime-question', found: '' };
	const type = prop(value, 'type')?.value;
	if (type?.kind === 'string')
		return { reason: 'unknown-type', found: type.value };
	if (type) return { reason: 'runtime-type', found: '' };
	// An entry with neither a type nor a body is not a question at all. Say nothing.
	// One with members the reader could not see may hold its type among them.
	return hasBody(value) && !value.partial
		? { reason: 'missing-type', found: '' }
		: undefined;
}

/** The span of a `type` value that names no question type: the thing to underline. */
function unknownType(value: Node): Span | undefined {
	if (value.kind !== 'object') return undefined;
	const type = prop(value, 'type')?.value;
	return type?.kind === 'string' ? type.span : undefined;
}

function collectEntry(entry: Prop, sink: Sink, map: number): void {
	const named = { id: entry.key, span: entry.keySpan };
	// Inside a map a known type is enough: a question with no body is still a question, and a broken one.
	if (entry.value.kind === 'object' && typeOf(entry.value)) {
		sink.questions.push(fromObject(entry.value, named, true, map));
		return;
	}
	if (isHelper(entry.value, sink)) {
		sink.questions.push(fromCall(entry.value, named, map));
		return;
	}
	const malformed = describeMalformed(entry.value);
	if (malformed) {
		sink.malformed.push({
			id: entry.key,
			anchor: unknownType(entry.value) ?? entry.keySpan,
			...malformed,
		});
	}
	visit(entry.value, undefined, sink);
}

function isMapEntry(value: Node, sink: Sink): boolean {
	return isQuestionObject(value) || isHelper(value, sink);
}

/** True when `questions` was a question map and has been collected. */
function collectMap(node: ObjectNode, sink: Sink): boolean {
	const questions = prop(node, 'questions')?.value;
	if (questions?.kind !== 'object') return false;
	if (!questions.props.some((entry) => isMapEntry(entry.value, sink)))
		return false;
	const map = sink.maps.length;
	sink.maps.push({
		entries: questions.props.map((entry) => ({
			id: entry.key,
			idSpan: entry.keySpan,
		})),
		state: prop(node, 'state')?.value,
		stateKey: prop(node, 'state')?.keySpan,
	});
	for (const entry of questions.props) collectEntry(entry, sink, map);
	for (const value of questions.loose ?? []) visit(value, undefined, sink);
	return true;
}

function oxlintRules(node: ObjectNode): ArrayNode | undefined {
	const setting = prop(node, OXLINT_RULE)?.value;
	if (setting?.kind !== 'array') return undefined;
	const options = setting.items[1];
	if (options?.kind !== 'object') return undefined;
	const rules = prop(options, 'rules')?.value;
	return rules?.kind === 'array' ? rules : undefined;
}

/** Each `jev/ask` rule in an oxlint-plugin-jev config is a Noul question with its own id. */
function collectOxlint(node: ObjectNode, sink: Sink): void {
	const rules = oxlintRules(node);
	if (!rules) return;
	const entries: { id: string; idSpan: Span }[] = [];
	for (const rule of rules.items) {
		if (rule.kind !== 'object') continue;
		const question = prop(rule, 'question');
		if (!question) continue;
		const id = prop(rule, 'id')?.value;
		const named =
			id?.kind === 'string' ? { id: id.value, span: id.span } : undefined;
		if (named) entries.push({ id: named.id, idSpan: named.span });
		sink.questions.push({
			id: named?.id,
			anchor: named?.span ?? question.keySpan,
			span: rule.span,
			type: 'noul',
			instructions: question.value,
			criteria: undefined,
			criteriaKey: undefined,
			open: false,
			inRequest: true,
			map: undefined,
		});
	}
	sink.maps.push({ entries, state: undefined, stateKey: undefined });
}

function collectModel(node: ObjectNode, sink: Sink): void {
	const model = prop(node, 'model')?.value;
	if (model?.kind === 'string')
		sink.models.push({ value: model.value, span: model.span });
}

function visitObject(node: ObjectNode, named: Named, sink: Sink): void {
	if (isQuestionObject(node)) {
		sink.questions.push(fromObject(node, named, false));
		return;
	}
	collectModel(node, sink);
	collectOxlint(node, sink);
	const mapped = collectMap(node, sink);
	for (const child of node.props) {
		if (mapped && child.key === 'questions') continue;
		// A struct can hold its question under a field named for the type. That is not an id.
		const named =
			child.key === 'type' ? undefined : { id: child.key, span: child.keySpan };
		visit(child.value, named, sink);
	}
	for (const value of node.loose ?? []) visit(value, undefined, sink);
}

function visitCall(node: CallNode, named: Named, sink: Sink): void {
	if (sink.trusted.has(node.callee)) {
		sink.questions.push(fromCall(node, named));
		return;
	}
	for (const arg of node.args) visit(arg, undefined, sink);
}

function visit(node: Node, named: Named, sink: Sink): void {
	if (node.kind === 'object') {
		visitObject(node, named, sink);
		return;
	}
	if (node.kind === 'call') {
		visitCall(node, named, sink);
		return;
	}
	const children = childrenOf(node);
	for (const child of children) visit(child, undefined, sink);
}

function childrenOf(node: Node): ReadonlyArray<Node> {
	if (node.kind === 'array') return node.items;
	return node.kind === 'unreadable' ? node.inner : [];
}

/** Finds the Jev questions, question maps and model names in a file's literals. */
export function extract(
	nodes: ReadonlyArray<Node>,
	trusted: ReadonlySet<string>,
): Extraction {
	const sink: Sink = {
		questions: [],
		maps: [],
		malformed: [],
		models: [],
		trusted,
	};
	for (const node of nodes) visit(node, undefined, sink);
	return Object.freeze({
		questions: sink.questions,
		maps: sink.maps,
		malformed: sink.malformed,
		models: sink.models,
	});
}
