import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText, readQuestions } from '../lint/lint';
import type { Fix } from '../types';

const read = (text: string) => readQuestions(text, 'python');
const lint = (text: string) => lintText(text, DEFAULT_OPTIONS, 'python');
const codes = (text: string) =>
	lint(text).findings.map((finding) => finding.code);
const SDK = 'from typesafe_sdk import Choice, Noul, Score, TypeSafeClient\n';

function apply(text: string, fix: Fix | undefined): string {
	if (!fix) throw new Error('no fix offered');
	return [...fix.edits]
		.sort((a, b) => b.span.start - a.span.start)
		.reduce(
			(out, edit) =>
				out.slice(0, edit.span.start) + edit.text + out.slice(edit.span.end),
			text,
		);
}

describe('Python dicts', () => {
	it('reads a request written as a dict, with True, False and None', () => {
		const found = read(`payload = {
    "state": ticket,
    "model": "jev-1.13.0",
    "questions": {
        "is_urgent": {"type": "noul", "instructions": "Is it urgent?"},
        "team": {"type": "choice", "instructions": "Which team takes it?", "criteria": {"billing": None, "other": None}},
    },
}`);
		expect(found.questions.map((q) => [q.id, q.type, q.inRequest])).toEqual([
			['is_urgent', 'noul', true],
			['team', 'choice', true],
		]);
		expect(found.models[0]?.value).toBe('jev-1.13.0');
	});

	it('joins adjacent strings, bracketed strings and triple-quoted strings', () => {
		const found = read(`q = {
    "type": "noul",
    "instructions": (
        "Does the customer "
        'ask for a refund?'
    ),
}
r = {"type": "noul", "instructions": """Is it
late?"""}`);
		expect(found.questions.map((q) => q.instructions)).toMatchObject([
			{ kind: 'string', value: 'Does the customer ask for a refund?' },
			{ kind: 'string', value: 'Is it\nlate?' },
		]);
	});

	it('does not read braces inside comments, strings and f-strings', () => {
		const found = read(`# {"type": "noul", "instructions": "no"}
note = "{'type': 'noul', 'instructions': 'no'}"
log = f"{ {'type': 'noul', 'instructions': name} }"`);
		expect(found.questions).toEqual([]);
	});

	it.each([
		['a variable', 'PROMPT'],
		['a conditional', `"a" if x else "b"`],
		['bytes', `b"Is it late?"`],
	])('calls %s unreadable', (_name, value) => {
		const text = `q = {"questions": {"a": {"type": "noul", "instructions": ${value}}}}`;
		expect(read(text).questions[0]?.instructions?.kind).toBe('unreadable');
		expect(lint(text).unreadableCount).toBe(1);
	});

	it.each([
		['an f-string', `f"Is {name} late by more than {limit} days?"`],
		['a format call', `"Is {} late by more than {} days?".format(name, limit)`],
		[
			'strings joined to a name',
			`"Is " + name + " late by more than " + str(limit) + " days?"`,
		],
	])(
		'keeps the fixed text of %s, and still counts it as not fully read',
		(_name, value) => {
			const text = `q = {"questions": {"a": {"type": "noul", "instructions": ${value}}}}`;
			expect(read(text).questions[0]?.instructions).toMatchObject({
				value: 'Is `…` late by more than `…` days?',
				slots: true,
			});
			expect(lint(text).unreadableCount).toBe(1);
		},
	);

	it('reads an f-string with no slot, and a raw string as written', () => {
		const found = read(
			`q = {"questions": {"a": {"type": "noul", "instructions": f"Is {{it}} late?"}, "b": {"type": "noul", "instructions": r"Does it match \\d+?"}}}`,
		);
		expect(found.questions.map((q) => q.instructions)).toMatchObject([
			{ value: 'Is {it} late?' },
			{ value: 'Does it match \\d+?' },
		]);
	});

	it('decodes escapes the way Python does', () => {
		const source = String.raw`q = {"questions": {"a": {"type": "noul", "instructions": "Café \x41\101 it\'s \d late?\n"}}}`;
		expect(read(source).questions[0]?.instructions).toMatchObject({
			value: `Café AA it's ${String.raw`\d`} late?\n`,
		});
	});

	it('reads a value continued over a line with a backslash', () => {
		const found = read(
			'q = {"questions": {"a": {"type": "noul", "instructions": "Is it " \\\n    "late?"}}}',
		);
		expect(found.questions[0]?.instructions).toMatchObject({
			value: 'Is it late?',
		});
	});

	it('marks a dict with a spread or a name for a key as partial', () => {
		const spread = read(
			`q = {"questions": {"a": {"type": "choice", "instructions": "Which one fits?", **extra}}}`,
		);
		expect(spread.questions[0]?.open).toBe(true);
		const keyed = read(
			`q = {"questions": {"a": {"type": "choice", "instructions": "Which one fits?", "criteria": {LATE: "Arrived late", "other": None}}}}`,
		);
		expect(keyed.questions[0]?.criteria).toMatchObject({
			kind: 'object',
			partial: true,
		});
	});

	it('takes a set and a comprehension for what they are', () => {
		expect(
			read(
				`tags = {"noul", "choice"}\nm = {k: {"type": "noul", "instructions": v} for k, v in items}`,
			).maps,
		).toEqual([]);
	});

	it('keeps duplicate keys', () => {
		const text = `q = {"questions": {"a": {"type": "noul", "instructions": "Is there one?"}, "a": {"type": "noul", "instructions": "Are there two?"}}}`;
		expect(codes(text)).toContain('JEV005');
	});
});

describe('the Python SDK', () => {
	it('reads the question classes by keyword', () => {
		const found = read(`${SDK}questions = {
    "is_urgent": Noul(instructions="Is it urgent?"),
    "team": Choice(criteria={"billing": "Charges", "other": None}, instructions="Which team takes it?"),
    "mood": Score(instructions="How upset are they?", criteria=["Calm", "Annoyed", "Furious"]),
}`);
		expect(found.questions.map((q) => [q.id, q.type, q.inRequest])).toEqual([
			['is_urgent', 'noul', true],
			['team', 'choice', true],
			['mood', 'score', true],
		]);
		expect(found.maps[0]?.entries.map((entry) => entry.id)).toEqual([
			'is_urgent',
			'team',
			'mood',
		]);
	});

	it('reads system_one by position and by keyword, with its state', () => {
		const byPosition = read(
			`${SDK}client.system_one({"note": "n"}, {"a": Noul(instructions="Is it so?")}, model="jev-latest")`,
		);
		expect(byPosition.questions[0]?.id).toBe('a');
		expect(byPosition.maps[0]?.state?.kind).toBe('object');
		expect(byPosition.models[0]?.value).toBe('jev-latest');
		const byKeyword = read(
			`${SDK}await client.system_one(state=ticket, questions={"a": Noul(instructions="Is it so?")})`,
		);
		expect(byKeyword.questions[0]?.id).toBe('a');
	});

	it('follows an alias and the module name, and nothing else', () => {
		const alias = read(
			`from typesafe_sdk import Noul as N\nq = {"a": N(instructions="Is it so?")}`,
		);
		expect(alias.questions).toHaveLength(1);
		const module = read(
			`import typesafe_sdk as ts\nq = {"a": ts.Score(instructions="Rate the damage", criteria=["x", "y"])}`,
		);
		expect(module.questions[0]?.type).toBe('score');
	});

	it("reads a wrapper library's class when its arguments are the question keywords", () => {
		const found = read(
			`from jevper import Choice\nimport kit\nq = {"a": Choice(instructions="Which one fits?", criteria={"a": None}), "b": kit.Noul(instructions="Is it so?")}`,
		);
		expect(found.questions.map((q) => q.type)).toEqual(['choice', 'noul']);
	});

	it.each([
		['other keywords', `Choice(title="Red", value=1)`],
		['a positional argument', `Score("high")`],
		['no arguments', `Noul()`],
		['a splat', `Choice(**fields)`],
	])('does not read a class from elsewhere called with %s', (_name, call) => {
		expect(
			read(`from questionary import Choice\nq = {"a": ${call}}`).questions,
		).toEqual([]);
	});

	it('keeps a question written under a key built at runtime', () => {
		const loop = read(
			`questions = {f"p{i}": {"type": "choice", "instructions": "Which one fits?", "criteria": {"a": None, "b": None}} for i in items}`,
		);
		expect(loop.questions.map((q) => [q.id, q.type])).toEqual([
			[undefined, 'choice'],
		]);
		const keyed = read(
			`q = {"questions": {KEY: {"type": "noul", "instructions": "Is it so?"}, "b": {"type": "noul", "instructions": "Are there two?"}}}`,
		);
		expect(keyed.questions.map((q) => q.id)).toEqual(['b', undefined]);
	});

	it('does not read a class or function that shares a name', () => {
		expect(
			read(`${SDK}class Score(Base):\n    pass\ndef Choice(x):\n    return x`)
				.questions,
		).toEqual([]);
	});

	it('calls a question with a positional or splatted argument partial', () => {
		const found = read(
			`${SDK}q = {"questions": {"a": Choice(**fields), "b": Score(LEVELS, instructions="Rate the damage")}}`,
		);
		expect(found.questions.map((q) => q.open)).toEqual([true, true]);
		expect(
			codes(`${SDK}q = {"questions": {"a": Choice(**fields)}}`),
		).not.toContain('JEV006');
	});
});

describe('rules on Python', () => {
	it('reports the same findings a JSON request would', () => {
		const text = `${SDK}client.system_one(
    ticket,
    {
        "team": Choice(instructions="Which team takes it?", criteria={"billing": "Charges", "technical": "Faults"}),
        "mood": Score(instructions="How upset are they?", criteria=["1", "2", "3"]),
        "wear": Score(instructions="How worn is it?", criteria={"light": "One fault", "heavy": "Several faults"}),
        "kind": Choice(instructions="Which kind is it?"),
    },
    model="jev-latest",
)`;
		expect(codes(text)).toEqual([
			'JEV004',
			'JEV008',
			'JEV006',
			'JEV006',
			'JEV001',
		]);
	});

	it('finds nothing in a file that never mentions Jev', () => {
		expect(lint('x = {"type": "report", "items": [1, 2]}').questionCount).toBe(
			0,
		);
	});

	it('honours a suppression written as a Python comment', () => {
		const text = `${SDK}q = {"questions": {
    # jevlint-le-disable-next-line JEV004
    "team": Choice(instructions="Which team takes it?", criteria={"billing": "Charges", "technical": "Faults"}),
}}`;
		expect(codes(text)).toEqual([]);
	});
});

describe('fixes on Python', () => {
	const finding = (text: string, code: string) => {
		const found = lint(text).findings.find(
			(candidate) => candidate.code === code,
		);
		if (!found) throw new Error(`no ${code}`);
		return found;
	};

	it('adds a fallback option as a quoted key, never a bare name', () => {
		const text = `${SDK}q = {"questions": {"team": Choice(instructions="Which team takes it?", criteria={'billing': 'Charges', 'technical': 'Faults'})}}`;
		const out = apply(text, finding(text, 'JEV004').fix);
		expect(out).toContain(
			`'technical': 'Faults', 'other': 'Fits none of the other options'}`,
		);
		expect(codes(out)).toEqual([]);
	});

	it('turns a Choice list into a dict with None', () => {
		const text = `${SDK}q = {"questions": {"team": Choice(instructions="Which team takes it?", criteria=["billing", "other"])}}`;
		const out = apply(text, finding(text, 'JEV006').fix);
		expect(out).toContain('criteria={ "billing": None, "other": None }');
		expect(codes(out)).toEqual([]);
	});

	it('pins a model written with a prefix', () => {
		const text = `${SDK}client.system_one(ticket, {"a": Noul(instructions="Is it so?")}, model=r'jev-latest')`;
		expect(apply(text, finding(text, 'JEV001').fix)).toContain(
			'model="jev-1.13.0")',
		);
	});
});
