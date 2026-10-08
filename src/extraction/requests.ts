import type {
	ArrayNode,
	CallNode,
	Dialect,
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
	StringNode,
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
// The Vercel AI SDK names the yes/no type `boolean`, OpenAI's Decisions API `predicate`.
const TYPE_ALIASES: Readonly<Record<string, QuestionType>> = Object.freeze({
	boolean: 'noul',
	predicate: 'noul',
});
// Field names older payloads and clients this reader does not know use for the same things.
const FOREIGN_FIELDS: ReadonlySet<string> = new Set([
	'prompt',
	'legend',
	'rubric',
	'labels',
	'descriptions',
	'answer',
	'probabilities',
]);
// The fields each dialect keeps its options or levels in.
const CRITERIA_FIELDS: ReadonlySet<string> = new Set([
	'criteria',
	'choices',
	'levels',
	'options',
]);
const OXLINT_RULE = 'jev/ask';

function prop(node: ObjectNode, key: string): Prop | undefined {
	return node.props.find((candidate) => candidate.key === key);
}

function hasBody(node: ObjectNode): boolean {
	return node.props.some(
		(entry) => entry.key === 'instructions' || CRITERIA_FIELDS.has(entry.key),
	);
}

function typeName(node: ObjectNode): string | undefined {
	const type = prop(node, 'type')?.value;
	return type?.kind === 'string' ? type.value : undefined;
}

function typeOf(node: ObjectNode): QuestionType | undefined {
	const type = typeName(node);
	if (type === undefined) return undefined;
	const alias = TYPE_ALIASES[type];
	if (alias) return alias;
	return TYPES.has(type) ? (type as QuestionType) : undefined;
}

const isObjectItem = (item: Node): boolean =>
	item.kind === 'object' || item.kind === 'unreadable';
const isTextItem = (item: Node): boolean =>
	item.kind === 'string' || item.kind === 'unreadable';

/**
 * Whose shape a question is written in, or undefined for a shape this reader
 * does not know, whose fields then prove nothing. OpenAI's carries `name`,
 * `predicate`, or lists of `{ value, description }` and `{ label,
 * description }`. Vercel's AI SDK carries `boolean`, an `options` map, or
 * `levels` as plain strings.
 */
function dialectOf(node: ObjectNode): Dialect | undefined {
	const type = typeName(node);
	const choices = prop(node, 'choices')?.value;
	const levels = prop(node, 'levels')?.value;
	const options = prop(node, 'options')?.value;
	if (type === 'predicate' || prop(node, 'name')) return 'openai';
	if (
		choices?.kind === 'array' &&
		choices.items.length &&
		choices.items.every(isObjectItem)
	)
		return 'openai';
	if (
		levels?.kind === 'array' &&
		levels.items.length &&
		levels.items.every(isObjectItem)
	)
		return 'openai';
	if (type === 'boolean') return 'vercel';
	if (options?.kind === 'object') return 'vercel';
	if (
		levels?.kind === 'array' &&
		levels.items.length &&
		levels.items.every(isTextItem)
	)
		return 'vercel';
	if (choices || levels || options) return undefined;
	return 'typesafe';
}

function isQuestionObject(node: Node): boolean {
	return node.kind === 'object' && typeOf(node) !== undefined && hasBody(node);
}

function isHelper(node: Node, sink: Sink): node is CallNode {
	return node.kind === 'call' && sink.trusted.has(node.callee);
}

/** OpenAI's `choices: [{ value, description }]` as the map the rules read. */
function mapOfChoices(list: ArrayNode): ObjectNode {
	let partial = list.partial;
	const props: Prop[] = [];
	for (const item of list.items) {
		const value =
			item.kind === 'object' ? prop(item, 'value')?.value : undefined;
		if (item.kind !== 'object' || item.partial || value?.kind !== 'string') {
			partial = true;
			continue;
		}
		props.push({
			key: value.value,
			keySpan: value.span,
			quote: '"',
			value: prop(item, 'description')?.value ?? {
				kind: 'null',
				span: value.span,
			},
		});
	}
	return { kind: 'object', props, partial, span: list.span };
}

/** OpenAI's `levels: [{ label, description }]` as the array of descriptions the rules read, with the labels beside it. */
function arrayOfLevels(
	list: ArrayNode,
): Readonly<{ criteria: ArrayNode; labels: ReadonlyArray<StringNode> }> {
	let partial = list.partial;
	const items: Node[] = [];
	const labels: StringNode[] = [];
	for (const item of list.items) {
		if (item.kind !== 'object' || item.partial) {
			partial = true;
			continue;
		}
		const label = prop(item, 'label')?.value;
		if (label?.kind === 'string') labels.push(label);
		items.push(
			prop(item, 'description')?.value ?? { kind: 'null', span: item.span },
		);
	}
	return {
		criteria: { kind: 'array', items, partial, span: list.span },
		labels,
	};
}

type Criteria = Readonly<{
	node: Node | undefined;
	key: Span | undefined;
	raw?: Node;
	labels?: ReadonlyArray<StringNode>;
}>;

function criteriaOf(
	node: ObjectNode,
	dialect: Dialect,
	type: QuestionType,
): Criteria {
	if (dialect === 'typesafe') {
		const field = prop(node, 'criteria');
		return { node: field?.value, key: field?.keySpan };
	}
	if (type === 'noul') return { node: undefined, key: undefined };
	if (dialect === 'vercel') {
		const field = prop(node, type === 'choice' ? 'options' : 'levels');
		return { node: field?.value, key: field?.keySpan };
	}
	const field = prop(node, type === 'choice' ? 'choices' : 'levels');
	const value = field?.value;
	if (!field || value?.kind !== 'array')
		return {
			node: value,
			key: field?.keySpan,
			...(value ? { raw: value } : {}),
		};
	if (type === 'choice')
		return { node: mapOfChoices(value), key: field.keySpan, raw: value };
	const { criteria, labels } = arrayOfLevels(value);
	return { node: criteria, key: field.keySpan, raw: value, labels };
}

function fromObject(
	node: ObjectNode,
	named: Named,
	inRequest: boolean,
	map?: number,
): Question {
	const typeProp = prop(node, 'type') as Prop;
	const type = typeOf(node) as QuestionType;
	const known = dialectOf(node);
	const dialect = known ?? 'typesafe';
	const criteria = criteriaOf(node, dialect, type);
	return {
		id: named?.id,
		dialect,
		...(criteria.labels ? { levelLabels: criteria.labels } : {}),
		...(criteria.raw ? { criteriaRaw: criteria.raw } : {}),
		anchor: named?.span ?? typeProp.value.span,
		span: node.span,
		type,
		instructions: prop(node, 'instructions')?.value,
		criteria: criteria.node,
		criteriaKey: criteria.key,
		open:
			node.partial ||
			known === undefined ||
			node.props.some((entry) => FOREIGN_FIELDS.has(entry.key)),
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
		dialect: 'typesafe',
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
			dialect: dialectOfEntry(entry.value),
			anchor: unknownType(entry.value) ?? entry.keySpan,
			...malformed,
		});
	}
	visit(entry.value, undefined, sink);
}

function isMapEntry(value: Node, sink: Sink): boolean {
	return isQuestionObject(value) || isHelper(value, sink);
}

const QUESTION_KEYS: ReadonlySet<string> = new Set([
	'type',
	'name',
	'instructions',
	...CRITERIA_FIELDS,
]);

// One slip away from a real type: a letter added, dropped or changed, or two
// neighbours swapped. 'nuol' and 'choise' are. 'bool', 'null' and 'multiple'
// are not, and a map of those is some other program's data.
function oneSlipFrom(found: string, type: string): boolean {
	const [a, b] = [found.toLowerCase(), type];
	if (a === b || Math.abs(a.length - b.length) > 1) return false;
	let start = 0;
	while (start < a.length && a[start] === b[start]) start += 1;
	let end = 0;
	while (
		end < Math.min(a.length, b.length) - start &&
		a[a.length - 1 - end] === b[b.length - 1 - end]
	)
		end += 1;
	const [restA, restB] = [
		a.slice(start, a.length - end),
		b.slice(start, b.length - end),
	];
	if (restA.length <= 1 && restB.length <= 1) return true;
	return (
		restA.length === 2 &&
		restB.length === 2 &&
		restA[0] === restB[1] &&
		restA[1] === restB[0]
	);
}

/**
 * True for an entry that is plainly meant as a question and is broken: it has
 * instructions, nothing but a question's own fields, and either a type one
 * slip from a real one or no type beside criteria. A request whose only
 * question is mistyped has no valid entry to mark its map as questions, and
 * without this it was passed over in silence.
 */
function isBrokenQuestion(value: Node): boolean {
	if (value.kind !== 'object' || value.partial) return false;
	if (!prop(value, 'instructions')) return false;
	if (!value.props.every((entry) => QUESTION_KEYS.has(entry.key))) return false;
	const type = prop(value, 'type')?.value;
	if (!type) return value.props.some((entry) => CRITERIA_FIELDS.has(entry.key));
	if (type.kind !== 'string') return false;
	const real = [...TYPES, ...Object.keys(TYPE_ALIASES)];
	return real.filter((name) => oneSlipFrom(type.value, name)).length === 1;
}

/** The dialect a broken entry was written in, read from the fields it does have. */
function dialectOfEntry(value: Node): Dialect {
	return value.kind === 'object'
		? (dialectOf(value) ?? 'typesafe')
		: 'typesafe';
}

/** True when `questions` was a question map and has been collected. */
function collectMap(node: ObjectNode, sink: Sink): boolean {
	const questions = prop(node, 'questions')?.value;
	if (questions?.kind !== 'object') return false;
	const marked = questions.props.some(
		(entry) => isMapEntry(entry.value, sink) || isBrokenQuestion(entry.value),
	);
	if (!marked) return false;
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

/** The `name` of a question in a list, which is its id. */
function nameOf(value: Node): Named {
	const name = value.kind === 'object' ? prop(value, 'name')?.value : undefined;
	return name?.kind === 'string'
		? { id: name.value, span: name.span }
		: undefined;
}

/**
 * True when `questions` was a list of named questions, OpenAI's shape, and
 * has been collected. The evidence beside it is `input` there, not `state`.
 */
function collectList(node: ObjectNode, sink: Sink): boolean {
	const questions = prop(node, 'questions')?.value;
	if (questions?.kind !== 'array') return false;
	const marked = questions.items.some(
		(item) => isMapEntry(item, sink) || isBrokenQuestion(item),
	);
	if (!marked) return false;
	const map = sink.maps.length;
	const evidence = prop(node, 'input') ?? prop(node, 'state');
	sink.maps.push({
		entries: questions.items.flatMap((item) => {
			const named = nameOf(item);
			return named ? [{ id: named.id, idSpan: named.span }] : [];
		}),
		state: evidence?.value,
		stateKey: evidence?.keySpan,
	});
	for (const item of questions.items) {
		const named = nameOf(item);
		if (item.kind === 'object' && typeOf(item)) {
			sink.questions.push(fromObject(item, named, true, map));
			continue;
		}
		const malformed = describeMalformed(item);
		if (malformed) {
			sink.malformed.push({
				id: named?.id,
				// An entry in OpenAI's list is in OpenAI's shape, whatever fields it lost.
				dialect: 'openai',
				anchor: unknownType(item) ?? named?.span ?? item.span,
				...malformed,
			});
		}
		visit(item, undefined, sink);
	}
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
			dialect: 'typesafe',
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
	const mapped = collectMap(node, sink) || collectList(node, sink);
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
