import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText, readQuestions } from '../lint/lint';
import type { ReportedFinding, Syntax } from '../types';

const codes = (text: string, syntax: Syntax = 'js') =>
	lintText(text, DEFAULT_OPTIONS, syntax).findings.map((f) => f.code);

function finding(
	text: string,
	code: string,
	syntax: Syntax = 'js',
): ReportedFinding {
	const found = lintText(text, DEFAULT_OPTIONS, syntax).findings.find(
		(f) => f.code === code,
	);
	if (!found) throw new Error(`no ${code} finding`);
	return found;
}

function apply(text: string, target: ReportedFinding): string {
	const edit = target.fix?.edits[0];
	if (!edit) throw new Error('finding has no fix');
	return text.slice(0, edit.span.start) + edit.text + text.slice(edit.span.end);
}

const OPENAI_BODY = `{
  "model": "gpt-6-luna",
  "input": "My parcel came three days late and the lid is cracked.",
  "questions": [
    { "type": "predicate", "name": "late", "instructions": "Did more than two parcels arrive late?" },
    { "type": "choice", "name": "team", "instructions": "Which team should handle this?",
      "choices": [ { "value": "billing", "description": "Billing" }, { "value": "delivery", "description": "Late or damaged parcels" } ] },
    { "type": "score", "name": "severity", "instructions": "Rate",
      "levels": [ { "label": "low", "description": "Low" }, { "label": "high", "description": "Nobody can log in" } ] }
  ]
}`;

describe("OpenAI's Decisions API shape", () => {
	it('reads a request body: names as ids, input as state, every question in its dialect', () => {
		const { questions, maps } = readQuestions(OPENAI_BODY, 'js');
		expect(questions.map((q) => [q.id, q.type, q.dialect])).toEqual([
			['late', 'noul', 'openai'],
			['team', 'choice', 'openai'],
			['severity', 'score', 'openai'],
		]);
		expect(maps[0]?.entries.map((e) => e.id)).toEqual([
			'late',
			'team',
			'severity',
		]);
		expect(maps[0]?.state?.kind).toBe('string');
		expect(questions[1]?.criteria).toMatchObject({
			kind: 'object',
			props: [{ key: 'billing' }, { key: 'delivery' }],
		});
		expect(questions[2]?.criteria).toMatchObject({ kind: 'array' });
		expect(questions[2]?.levelLabels?.map((l) => l.value)).toEqual([
			'low',
			'high',
		]);
	});

	it('runs every rule with evidence behind it, and none about the TypeSafe API', () => {
		expect(codes(OPENAI_BODY)).toEqual([
			'JEV102',
			'JEV004',
			'JEV011',
			'JEV012',
			'JEV011',
		]);
	});

	it('names Luna in its messages, not Jev', () => {
		const messages = lintText(OPENAI_BODY).findings.map((f) => f.message);
		expect(messages.some((m) => /\bJev\b/.test(m))).toBe(false);
		expect(finding(OPENAI_BODY, 'JEV102').message).toContain(
			'asks Luna to count',
		);
		expect(finding(OPENAI_BODY, 'JEV011').message).toContain(
			'Luna matches the state',
		);
	});

	it('is read through the openai SDK in TypeScript and Python', () => {
		const ts = `const r = await client.decisions.create({ model: 'gpt-6-luna', input: text, questions: [{ type: 'predicate', name: 'refund', instructions: 'Refund?' }] });`;
		expect(codes(ts)).toEqual(['JEV012']);
		const py = `r = client.decisions.create(model="gpt-6-luna", input=text, questions=[{"type": "predicate", "name": "refund", "instructions": "Refund?"}])`;
		expect(codes(py, 'python')).toEqual(['JEV012']);
		expect(readQuestions(py, 'python').questions[0]).toMatchObject({
			id: 'refund',
			inRequest: true,
		});
	});

	it('does not hold a Choice to the 255 options TypeSafe accepts', () => {
		const choices = Array.from(
			{ length: 300 },
			(_, i) => `{ "value": "o${i}", "description": "Option number ${i}" }`,
		).join(', ');
		const text = `{ "questions": [ { "type": "choice", "name": "q", "instructions": "Which one fits best?", "choices": [ ${choices}, { "value": "other", "description": "None of them" } ] } ] }`;
		expect(codes(text)).toEqual([]);
	});

	it.each([
		[
			'choices written as a map',
			`{ "questions": [ { "type": "choice", "name": "q", "instructions": "Which team takes it?", "choices": { "billing": "Charges" } } ] }`,
			'The choices of a choice question must be an array of { value, description }, not a map.',
		],
		[
			'choices written as bare names',
			`{ "questions": [ { "type": "choice", "name": "q", "instructions": "Which team takes it?", "choices": ["billing", "technical"] } ] }`,
			"Each entry of 'choices' must be an object with 'value' and 'description', not a string.",
		],
		[
			'a choice with no choices',
			`{ "questions": [ { "type": "choice", "name": "q", "instructions": "Which team takes it?" } ] }`,
			"A choice question needs 'choices': an array of { value, description }.",
		],
		[
			'a score with no levels',
			`{ "questions": [ { "type": "score", "name": "q", "instructions": "How bad is it?" } ] }`,
			"A score question needs 'levels': an ordered array of { label, description }.",
		],
	])(
		'reports the shape mistake of %s in its own words',
		(_name, text, message) => {
			const found = finding(text, 'JEV006');
			expect(found.message).toBe(message);
			expect(found.fix).toBeUndefined();
		},
	);

	it('offers the fallback option as a list entry, spelt like the one before it', () => {
		const text = `{ "questions": [ { "type": "choice", "name": "team", "instructions": "Which team takes it?", "choices": [\n    { "value": "billing", "description": "Charges" },\n    { "value": "technical", "description": "Faults" }\n  ] } ] }`;
		const fixed = apply(text, finding(text, 'JEV004'));
		expect(fixed).toContain(
			'{ "value": "technical", "description": "Faults" },\n    { "value": "other", "description": "Fits none of the other options" }\n  ]',
		);
		expect(codes(fixed)).toEqual([]);
		const ts = `const q = { type: 'choice', name: 'team', instructions: 'Which team takes it?', choices: [{ value: 'billing', description: 'Charges' }, { value: 'technical', description: 'Faults' }] };`;
		expect(apply(ts, finding(ts, 'JEV004'))).toContain(
			"{ value: 'technical', description: 'Faults' }, { value: 'other', description: 'Fits none of the other options' }]",
		);
	});

	it('reports a repeated name as a duplicate id', () => {
		const text = `{ "questions": [ { "type": "predicate", "name": "late", "instructions": "Is the parcel late?" }, { "type": "predicate", "name": "late", "instructions": "Is the lid cracked?" } ] }`;
		expect(codes(text)).toEqual(['JEV005']);
	});

	it('reports a mistyped type in a list the way it does in a map, in its own type names', () => {
		const text = `{ "questions": [ { "type": "predicat", "name": "late", "instructions": "Is the parcel late?" } ] }`;
		const found = finding(text, 'JEV007');
		expect(found.message).toBe(
			'Question type "predicat" does not exist. The types are predicate, choice and score.',
		);
		expect(found.fix?.title).toBe("Change to 'predicate'");
		expect(codes(apply(text, found))).toEqual([]);
	});
});

describe("the Vercel AI SDK's decide() shape", () => {
	const text = `import { experimental_decide as decide } from 'ai';
const result = await decide({
  model: 'openai/gpt-6-luna-decisions',
  state: 'The support agent issued a full refund to the customer.',
  questions: {
    refunded: { type: 'boolean', instructions: 'Refund?' },
    team: { type: 'choice', instructions: 'Which team takes it?', options: { billing: 'Billing', technical: 'Faults' } },
    sev: { type: 'score', instructions: 'How severe is it?', levels: ['Low', 'Medium', 'High'] },
  },
});`;

	it('reads options and levels as criteria', () => {
		expect(
			readQuestions(text, 'js').questions.map((q) => [q.id, q.type, q.dialect]),
		).toEqual([
			['refunded', 'noul', 'vercel'],
			['team', 'choice', 'vercel'],
			['sev', 'score', 'vercel'],
		]);
		expect(codes(text)).toEqual(['JEV012', 'JEV004', 'JEV011', 'JEV110']);
	});

	it('says "the model", since the SDK routes to either vendor', () => {
		expect(finding(text, 'JEV011').message).toContain(
			'The model matches the state',
		);
	});

	it('adds the fallback option to the options map', () => {
		expect(apply(text, finding(text, 'JEV004'))).toContain(
			"technical: 'Faults', other: 'Fits none of the other options' }",
		);
	});

	it('leaves an options list alone, since a client this reader does not know writes one too', () => {
		const wrong = `const q = { questions: { team: { type: 'choice', instructions: 'Which team takes it?', options: ['billing', 'technical'] } } };`;
		expect(codes(wrong)).toEqual([]);
	});
});

describe('a shape this reader does not know', () => {
	it('still proves nothing from a missing field', () => {
		const text = `const state = [{ key: 'a', type: 'score', instructions: 'How important is it?', rubric: [] }, { key: 'b', type: 'noul', instructions: '', options: [] }];`;
		expect(codes(text)).toEqual([]);
	});
});
