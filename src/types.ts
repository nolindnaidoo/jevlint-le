export type Span = Readonly<{ start: number; end: number }>;

export type StringNode = Readonly<{
	kind: 'string';
	value: string;
	span: Span;
	/**
	 * True when parts of the text are filled in at runtime. The value is then
	 * the fixed text, with a placeholder where each runtime part goes.
	 */
	slots?: boolean;
}>;

export type ObjectNode = Readonly<{
	kind: 'object';
	props: ReadonlyArray<Prop>;
	/** A spread, a computed key or a method: the object holds members the reader could not see. */
	partial: boolean;
	span: Span;
	/**
	 * Values whose key is known only at runtime. The key is lost, but a question
	 * written under it is still a question. Only the Python reader fills this.
	 */
	loose?: ReadonlyArray<Node>;
}>;

export type ArrayNode = Readonly<{
	kind: 'array';
	items: ReadonlyArray<Node>;
	partial: boolean;
	span: Span;
}>;

export type CallNode = Readonly<{
	kind: 'call';
	callee: string;
	args: ReadonlyArray<Node>;
	/** Arguments passed by name, where the language has them. */
	named?: ReadonlyArray<Prop>;
	span: Span;
}>;

export type Node =
	| StringNode
	| ObjectNode
	| ArrayNode
	| CallNode
	| Readonly<{ kind: 'number'; value: number; span: Span }>
	| Readonly<{ kind: 'boolean'; value: boolean; span: Span }>
	| Readonly<{ kind: 'null'; span: Span }>
	| UnreadableNode;

export type UnreadableNode = Readonly<{
	kind: 'unreadable';
	span: Span;
	/** Literals found inside the expression, so a question nested in a callback is still seen. */
	inner: ReadonlyArray<Node>;
}>;

export type Prop = Readonly<{
	key: string;
	keySpan: Span;
	/** The quote the key was written with, or '' for a bare identifier. */
	quote: string;
	value: Node;
}>;

/** Which reader a file needs. JSON is read by the JavaScript one. */
export type Syntax = 'js' | 'python' | 'rust' | 'go';

export type QuestionType = 'noul' | 'choice' | 'score';

/**
 * Whose request shape a question is written in. The rules read every dialect
 * the same way, through `criteria`; the dialect says which fields it came
 * from and which API's limits apply.
 *
 * - `typesafe`: `{ type: 'noul' | 'choice' | 'score', instructions, criteria }`
 * - `openai`: `{ type: 'predicate' | 'choice' | 'score', name, instructions, choices: [{ value, description }], levels: [{ label, description }] }`
 * - `vercel`: the AI SDK's `decide()`, `{ type: 'boolean' | 'choice' | 'score', instructions, options: {}, levels: [] }`
 */
export type Dialect = 'typesafe' | 'openai' | 'vercel';

export type Question = Readonly<{
	id: string | undefined;
	dialect: Dialect;
	/** An OpenAI Score's level labels, beside the descriptions `criteria` holds. */
	levelLabels?: ReadonlyArray<StringNode>;
	/** Where a finding about the whole question is anchored. */
	anchor: Span;
	/** The whole question as written, for finding the one under the cursor. */
	span: Span;
	type: QuestionType;
	/** `undefined` when the field is absent, as distinct from present and unreadable. */
	instructions: Node | undefined;
	criteria: Node | undefined;
	/** The `criteria` key, where a finding about the criteria's shape belongs. */
	criteriaKey: Span | undefined;
	/**
	 * The options or levels as written, for a dialect whose field `criteria`
	 * was read out of: OpenAI's `choices` or `levels` list. Shape rules and
	 * fixes work on this; every other rule reads `criteria`.
	 */
	criteriaRaw?: Node;
	/**
	 * True when a missing field proves nothing: the object has a spread, or it
	 * carries another dialect's fields (`prompt`, `options`, `legend`), so the
	 * field may be there under a name this reader does not know.
	 */
	open: boolean;
	/**
	 * True when the question sits where a request puts one: an entry in a
	 * `questions` map, or an SDK helper call. A lone `{ type, instructions }`
	 * may be a template, a mock or half of a builder, so nothing is concluded
	 * from what it lacks.
	 */
	inRequest: boolean;
	/** Which `questions` map this came from, as an index into the extraction's maps. */
	map: number | undefined;
}>;

export type QuestionMap = Readonly<{
	entries: ReadonlyArray<Readonly<{ id: string; idSpan: Span }>>;
	/** The `state` beside this `questions` map, when the request has one. */
	state: Node | undefined;
	/** The `state` key itself: where a finding about the state is underlined. */
	stateKey: Span | undefined;
}>;

export type Malformed = Readonly<{
	id: string | undefined;
	/** Whose type names to offer in place of the wrong one. */
	dialect: Dialect;
	anchor: Span;
	reason: 'unknown-type' | 'missing-type' | 'runtime-question' | 'runtime-type';
	found: string;
}>;

export type ModelRef = Readonly<{ value: string; span: Span }>;

export type Extraction = Readonly<{
	questions: ReadonlyArray<Question>;
	maps: ReadonlyArray<QuestionMap>;
	malformed: ReadonlyArray<Malformed>;
	models: ReadonlyArray<ModelRef>;
}>;

export type Severity = 'hint' | 'info' | 'warning' | 'error';

export type RuleCode =
	| 'JEV000'
	| 'JEV001'
	| 'JEV002'
	| 'JEV003'
	| 'JEV004'
	| 'JEV005'
	| 'JEV006'
	| 'JEV007'
	| 'JEV008'
	| 'JEV009'
	| 'JEV010'
	| 'JEV011'
	| 'JEV012'
	| 'JEV101'
	| 'JEV102'
	| 'JEV103'
	| 'JEV104'
	| 'JEV105'
	| 'JEV107'
	| 'JEV108'
	| 'JEV110'
	| 'JEV111'
	| 'JEV112'
	| 'JEV301'
	| 'JEV302'
	| 'JEV303'
	| 'JEV304'
	| 'JEV305'
	| 'JEV306'
	| 'JEV307'
	| 'JEV308'
	| 'JEV309'
	| 'JEV310'
	| 'JEV311'
	| 'JEV312';

export type TextEdit = Readonly<{ span: Span; text: string }>;

export type Fix = Readonly<{
	title: string;
	edits: ReadonlyArray<TextEdit>;
	/**
	 * True when the edit only mends something the API would refuse, so it can
	 * be applied unasked. False when it changes what a working request does,
	 * such as adding an option or pinning a model: that is the author's call.
	 */
	safe: boolean;
}>;

export type Finding = Readonly<{
	code: RuleCode;
	message: string;
	span: Span;
	questionId: string | undefined;
	fix: Fix | undefined;
}>;

export type ReportedFinding = Finding &
	Readonly<{
		severity: Severity;
		/** True when the finding is in JSON pasted into a string, where a comment cannot be written. */
		inString?: boolean;
	}>;

export type LintOptions = Readonly<{
	rules: Readonly<Partial<Record<RuleCode, Severity | 'off'>>>;
	fallbackOptions: ReadonlyArray<string>;
	ignore: ReadonlyArray<string>;
	/** Files a settings file leaves out, as patterns relative to that file. Only a settings file sets it. */
	exclude?: ReadonlyArray<string>;
}>;

export type LintResult = Readonly<{
	findings: ReadonlyArray<ReportedFinding>;
	questionCount: number;
	/** Questions with at least one field the reader could not see. Never folded into "clean". */
	unreadableCount: number;
}>;
