import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText, readQuestions } from '../lint/lint';
import type { Syntax } from '../types';

const shape = (text: string, syntax: Syntax = 'js') =>
	readQuestions(text, syntax).questions.map((q) =>
		[q.id ?? '-', q.type, q.inRequest ? 'request' : '']
			.filter(Boolean)
			.join(' '),
	);
const codes = (text: string, syntax: Syntax = 'js') =>
	lintText(text, DEFAULT_OPTIONS, syntax).findings.map((finding) =>
		`${finding.code} ${finding.questionId ?? ''}`.trim(),
	);

describe('a function that builds a question from its parameters', () => {
	it('is read at each call, in every language', () => {
		const cases: [Syntax, string][] = [
			[
				'js',
				`const ask = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
const q = { questions: { late: ask('How many parcels are late?', 'Some', 'None') } };`,
			],
			[
				'js',
				`function ask(instructions: string): Question { return { type: 'noul', instructions }; }
const q = { questions: { late: ask('How many parcels are late?') } };`,
			],
			[
				'python',
				`def ask(text):\n    return {"type": "noul", "instructions": text}\n\nq = {"questions": {"late": ask("How many parcels are late?")}}`,
			],
			[
				'rust',
				`fn ask(text: &str) -> Value { json!({"type": "noul", "instructions": text}) }
let q = json!({"questions": {"late": ask("How many parcels are late?")}});`,
			],
			[
				'go',
				`func ask(text string) Question { return Question{Type: "noul", Instructions: text} }
var q = map[string]any{"questions": map[string]Question{"late": ask("How many parcels are late?")}}`,
			],
		];
		for (const [syntax, text] of cases) {
			expect(shape(text, syntax)).toEqual(['late noul request']);
			expect(codes(text, syntax)).toEqual(['JEV102 late']);
		}
	});

	it('reports a finding on the argument, where the text is written', () => {
		const text = `const ask = (instructions) => ({ type: 'noul', instructions });\nconst q = { questions: { late: ask('How many parcels are late?') } };`;
		const found = lintText(text).findings[0];
		expect(text.slice(found?.span.start, found?.span.end)).toBe(
			"'How many parcels are late?'",
		);
	});

	it('is not itself a question, so it draws no hint', () => {
		expect(
			codes(
				`export const ask = (instructions, criteria) => ({ type: 'choice', instructions, criteria });`,
			),
		).toEqual([]);
	});

	it('fills the options from the call, and a fix edits them there', () => {
		const text = `function pick(instructions, criteria) { return { type: 'choice', instructions, criteria }; }
const q = { questions: { team: pick('Which team takes it?', { billing: 'Charges', technical: 'Faults' }) } };`;
		const found = lintText(text).findings[0];
		expect(found?.code).toBe('JEV004');
		const edit = found?.fix?.edits[0];
		if (!edit) throw new Error('no fix offered');
		const mended =
			text.slice(0, edit.span.start) + edit.text + text.slice(edit.span.end);
		expect(mended).toContain("technical: 'Faults', other:");
		expect(codes(mended)).toEqual([]);
	});

	it('takes Python arguments by name', () => {
		const text = `def ask(text, levels):\n    return {"type": "score", "instructions": text, "criteria": levels}\n\nq = {"questions": {"mood": ask(levels=["1", "2"], text="How upset are they?")}}`;
		expect(codes(text, 'python')).toEqual(['JEV008 mood']);
	});

	it('leaves a part unread when the call does not pass it or computes it', () => {
		const text = `const ask = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
const q = { questions: { a: ask('Which one fits?'), b: ask(build(), { x: 'Extra', other: 'Else' }) } };`;
		expect(codes(text)).toEqual(['JEV000 a', 'JEV000 b']);
	});

	it('keeps what the wrapper changes unread, and says so at each call', () => {
		const text = `def pick(text, options):\n    return {"type": "choice", "instructions": text, "criteria": dict.fromkeys(options)}\n\nq = {"questions": {"t": pick("Which team takes it?", ["billing", "technical"])}}`;
		expect(codes(text, 'python')).toEqual(['JEV000 t']);
	});

	it.each([
		[
			'defined twice',
			`function ask(instructions) { return { type: 'noul', instructions }; }\nfunction ask(instructions, x) { return { type: 'noul', instructions }; }`,
		],
		[
			'a method',
			`const api = { ask(instructions) { return { type: 'noul', instructions }; } };\nconst ask = api.ask;`,
		],
		[
			'a function that builds two questions',
			`function ask(instructions) { return [{ type: 'noul', instructions }, { type: 'noul', instructions }]; }`,
		],
		[
			'a function that builds none',
			`function ask(instructions) { return send(instructions); }`,
		],
	])('does not read a call to a name that is %s', (_name, setup) => {
		const text = `${setup}\nconst q = { questions: { late: ask('How many parcels are late?') } };`;
		expect(codes(text).filter((code) => code.startsWith('JEV102'))).toEqual([]);
	});

	it('does not read a call that only hands on what it was given', () => {
		const text = `function ask(instructions) { return { type: 'noul', instructions }; }
function outer(instructions) { return ask(instructions); }`;
		expect(shape(text)).toEqual([]);
		expect(codes(text)).toEqual([]);
	});

	it('reads a wrapper named like an SDK helper when the file defines it', () => {
		const text = `const noul = (instructions) => ({ type: 'noul', instructions });
const q = { questions: { late: noul('How many parcels are late?') } };`;
		expect(codes(text)).toEqual(['JEV102 late']);
	});
});
