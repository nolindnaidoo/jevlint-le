import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText, readQuestions } from '../lint/lint';
import type { Syntax } from '../types';

const wording = (text: string, syntax: Syntax = 'js') => {
	const node = readQuestions(text, syntax).questions[0]?.instructions;
	return node?.kind === 'string' ? node.value : node?.kind;
};
// Writes `${` without tripping the lint on template syntax inside a string.
const js = (source: string) => source.replace(/@\{/g, '$' + '{');
const codes = (text: string, syntax: Syntax = 'js') =>
	lintText(text, DEFAULT_OPTIONS, syntax).findings.map(
		(finding) => finding.code,
	);

describe('a name bound to a literal', () => {
	it('is followed to its text in every language', () => {
		const cases: [Syntax, string][] = [
			[
				'js',
				`const PROMPT = 'Is it late?';\nconst q = { questions: { a: { type: 'noul', instructions: PROMPT } } };`,
			],
			[
				'js',
				`const instructions: string = 'Is it late?';\nconst q = { questions: { a: { type: 'noul', instructions } } };`,
			],
			[
				'python',
				`PROMPT = "Is it late?"\nq = {"questions": {"a": {"type": "noul", "instructions": PROMPT}}}`,
			],
			[
				'rust',
				`const PROMPT: &str = "Is it late?";\nlet q = json!({"questions": {"a": {"type": "noul", "instructions": PROMPT}}});`,
			],
			[
				'go',
				`const prompt = "Is it late?"\nvar q = map[string]any{"questions": map[string]any{"a": map[string]any{"type": "noul", "instructions": prompt}}}`,
			],
		];
		for (const [syntax, text] of cases)
			expect(wording(text, syntax)).toBe('Is it late?');
	});

	it('is followed into a member of an object or a list', () => {
		const text = `const TEXT = { late: { ask: 'Is it late?' }, all: ['One?', 'Two?'] } as const;
const q = { questions: { a: { type: 'noul', instructions: TEXT.late.ask }, b: { type: 'noul', instructions: TEXT.all[1] }, c: { type: 'noul', instructions: TEXT['late'].ask } } };`;
		expect(
			readQuestions(text).questions.map(
				(q) => (q.instructions as { value: string }).value,
			),
		).toEqual(['Is it late?', 'Two?', 'Is it late?']);
	});

	it('reports a finding where the literal is written', () => {
		const text = `const MODEL = 'jev-latest';\nconst q = { model: MODEL, questions: { a: { type: 'noul', instructions: 'Is it late?' } } };`;
		const found = lintText(text).findings[0];
		expect(found?.code).toBe('JEV001');
		expect(text.slice(found?.span.start, found?.span.end)).toBe("'jev-latest'");
	});

	it('reports each question that shares a literal, and one fix mends them all', () => {
		const text = `const TEAMS = { billing: 'Charges', technical: 'Faults' };
const q = { questions: { a: { type: 'choice', instructions: 'Which team?', criteria: TEAMS }, b: { type: 'choice', instructions: 'Who owns it?', criteria: TEAMS } } };`;
		const found = lintText(text).findings;
		expect(found.map((finding) => finding.questionId)).toEqual(['a', 'b']);
		const edit = found[0]?.fix?.edits[0];
		if (!edit) throw new Error('no fix offered');
		const mended =
			text.slice(0, edit.span.start) + edit.text + text.slice(edit.span.end);
		expect(mended).toContain("technical: 'Faults', other:");
		expect(codes(mended)).toEqual([]);
	});

	it('reports a mistake in a shared literal once', () => {
		const text = `const LEVELS = ['1', '2', '3'];
const q = { questions: { a: { type: 'score', instructions: 'How bad?', criteria: LEVELS }, b: { type: 'score', instructions: 'How soon?', criteria: LEVELS } } };`;
		expect(codes(text)).toEqual(['JEV008']);
	});

	it('counts a question defined under a name and used in a request once', () => {
		const text = `const LATE = { type: 'noul', instructions: 'Is it late?' };\nconst q = { questions: { late: LATE } };`;
		expect(
			readQuestions(text).questions.map((q) => [q.id, q.inRequest]),
		).toEqual([['late', true]]);
	});

	it.each([
		['bound twice', `let P = 'One?';\nP = 'Two?';`],
		[
			'a parameter somewhere in the file',
			`const P = 'One?';\nfunction ask(P) { return P; }`,
		],
		['an arrow parameter', `const P = 'One?';\nconst ask = (P) => P;`],
		[
			'a container filled after it is written',
			`const P = [];\nP.push('One?');`,
		],
		['a container assigned into', `const P = {};\nP['a'] = 'One?';`],
		['an empty container', `const P = {};`],
		['built at runtime itself', `const P = build('One?');`],
		[
			'a type and not a value',
			`type P = { type: 'noul', instructions: string };`,
		],
	])('is not followed when it is %s', (_name, setup) => {
		const text = `${setup}\nconst q = { questions: { a: { type: 'noul', instructions: P } } };`;
		expect(wording(text)).toBe('unreadable');
	});

	it('is not taken from a type annotation', () => {
		const text = `import { Q } from './types';\nconst ROUTE: Q = { type: 'choice', instructions: 'Which?', criteria: { a: 'A', other: 'Else' } };`;
		expect(readQuestions(text).questions).toHaveLength(1);
		expect(codes(text)).toEqual([]);
	});

	it('counts a binding inside a callback, so two of them are not followed', () => {
		const text = `test('a', () => { const criteria = ['x']; use(criteria); });
const criteria = { a: 'A', b: 'B' };
test('b', () => { const q = { questions: { t: { type: 'choice', instructions: 'Which?', criteria } } }; });`;
		expect(codes(text)).toEqual(['JEV000']);
	});

	it('does not read a Python comprehension as a list of one', () => {
		const text = `levels = [l.strip() for l in raw.split(",")]\nq = {"questions": {"a": {"type": "score", "instructions": "Rate", "criteria": levels}}}`;
		expect(codes(text, 'python')).toEqual(['JEV000']);
	});
});

describe('text with runtime parts', () => {
	it('keeps its fixed text in every language', () => {
		const cases: [Syntax, string][] = [
			[
				'js',
				js(
					'const q = { questions: { a: { type: "noul", instructions: `Is @{name} late by @{n} days?` } } };',
				),
			],
			[
				'js',
				`const q = { questions: { a: { type: "noul", instructions: 'Is ' + name + ' late by ' + n + ' days?' } } };`,
			],
			[
				'python',
				`q = {"questions": {"a": {"type": "noul", "instructions": f"Is {name} late by {n} days?"}}}`,
			],
			[
				'rust',
				`let q = json!({"questions": {"a": {"type": "noul", "instructions": format!("Is {} late by {n} days?", name)}}});`,
			],
			[
				'go',
				`var q = map[string]any{"questions": map[string]any{"a": map[string]any{"type": "noul", "instructions": fmt.Sprintf("Is %s late by %d days?", name, n)}}}`,
			],
		];
		for (const [syntax, text] of cases)
			expect(wording(text, syntax)).toBe('Is `…` late by `…` days?');
	});

	it('runs the rules that the fixed text can answer, and still says it was not fully read', () => {
		const text = js(
			'const q = { questions: { a: { type: "noul", instructions: `How many of the items in @{field} are late?` } } };',
		);
		const found = lintText(text).findings;
		expect(found.map((finding) => finding.code)).toEqual(['JEV000', 'JEV102']);
		expect(found[0]?.message).toContain('The fixed text was checked');
		expect(lintText(text).unreadableCount).toBe(1);
	});

	it('does not call a boundary undefined when a slot may be where it is stated', () => {
		const slotted = js(
			'const q = { questions: { a: { type: "noul", instructions: `Is the order large? @{RULE}` } } };',
		);
		const plain = `const q = { questions: { a: { type: "noul", instructions: "Is the order large?" } } };`;
		expect(codes(plain)).toContain('JEV112');
		expect(codes(slotted)).toEqual(['JEV000']);
	});

	it('leaves a sum of two names alone', () => {
		expect(
			wording(
				`const q = { questions: { a: { type: 'noul', instructions: a + b } } };`,
			),
		).toBe('unreadable');
	});
});
