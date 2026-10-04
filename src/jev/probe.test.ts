import { describe, expect, it } from 'vitest';
import { buildProbe, readProbe, summarize } from './probe';

const STATE = { note: 'n' };
const MODEL = 'jev-1.13.0';
const names = (question: Parameters<typeof buildProbe>[1]) =>
	buildProbe(STATE, question, MODEL).map((variant) => variant.name);

describe('the variants of a question', () => {
	it('always starts with three identical requests', () => {
		expect(names({ type: 'noul', instructions: 'Is it?' })).toEqual([
			'as written 1',
			'as written 2',
			'as written 3',
		]);
	});

	it('reverses and blanks the options of a described Choice', () => {
		const question = {
			type: 'choice' as const,
			instructions: 'Which?',
			criteria: { late: 'Arrived late', damaged: 'Arrived damaged' },
		};
		expect(names(question).slice(3)).toEqual([
			'options reversed',
			'names hidden',
		]);
		const criteriaOf = (index: number) => {
			const sent = buildProbe(STATE, question, MODEL)[index]?.request.questions
				.q;
			return (sent as { criteria: Record<string, string> } | undefined)
				?.criteria;
		};
		expect(Object.keys(criteriaOf(3) ?? {})).toEqual(['damaged', 'late']);
		expect(criteriaOf(4)).toEqual({
			option_1: 'Arrived late',
			option_2: 'Arrived damaged',
		});
	});

	it('does not blank names when an option has no description to stand on', () => {
		expect(
			names({
				type: 'choice',
				instructions: 'Which?',
				criteria: { a: null, b: 'B' },
			}).slice(3),
		).toEqual(['options reversed']);
	});

	it('reverses the levels of a Score and removes the criteria of a Noul', () => {
		expect(
			names({
				type: 'score',
				instructions: 'Rate',
				criteria: ['x', 'y', 'z'],
			}).slice(3),
		).toEqual(['levels reversed']);
		expect(
			names({
				type: 'noul',
				instructions: 'Is it?',
				criteria: { true: 'a', false: 'b' },
			}).slice(3),
		).toEqual(['criteria removed']);
	});

	it('sends the state as it was given', () => {
		const [first] = buildProbe(
			STATE,
			{ type: 'noul', instructions: 'Is it?' },
			MODEL,
		);
		expect(first?.request).toEqual({
			state: STATE,
			model: MODEL,
			questions: { q: { type: 'noul', instructions: 'Is it?' } },
		});
	});
});

describe('reading a variant back', () => {
	it('maps a blank option name back to the real one', () => {
		const hidden = buildProbe(
			STATE,
			{
				type: 'choice',
				instructions: 'Which?',
				criteria: { late: 'L', damaged: 'D' },
			},
			MODEL,
		)[4];
		if (!hidden) throw new Error('no variant');
		expect(
			readProbe(hidden, { q: { choice: 'option_2', confidence: 0.7 } }),
		).toEqual({ decision: 'damaged', number: 0.7 });
	});

	it('flips a score read from reversed levels', () => {
		const reversed = buildProbe(
			STATE,
			{ type: 'score', instructions: 'Rate', criteria: ['x', 'y', 'z'] },
			MODEL,
		)[3];
		if (!reversed) throw new Error('no variant');
		expect(readProbe(reversed, { q: { score: 0.2 } })).toEqual({
			decision: '2',
			number: 1.8,
		});
	});
});

describe('the report', () => {
	const variants = buildProbe(
		STATE,
		{
			type: 'noul',
			instructions: 'Is it?',
			criteria: { true: 'a', false: 'b' },
		},
		MODEL,
	);
	const results = (numbers: number[]) =>
		variants.map((variant, i) => ({
			variant,
			reading: readProbe(variant, { q: { noul: numbers[i] ?? 0 } }),
		}));

	it('says the answer held, and how much repeats alone moved it', () => {
		const report = summarize('q1', 'noul', results([0.9, 0.88, 0.91, 0.8]));
		expect(report.moved).toEqual([]);
		expect(report.markdown).toContain('The answer held under every change.');
		expect(report.markdown).toContain('moved by 0.03');
	});

	it('names the change that flipped the answer', () => {
		const report = summarize('q1', 'noul', results([0.9, 0.9, 0.9, 0.3]));
		expect(report.moved).toEqual(['criteria removed']);
		expect(report.markdown).toContain(
			'| criteria removed | no | 0.30 | changed |',
		);
	});

	it('blames no layout when identical requests disagree', () => {
		const report = summarize('q1', 'noul', results([0.55, 0.45, 0.52, 0.3]));
		expect(report.moved).toEqual(['identical requests']);
		expect(report.markdown).toContain('too close to call');
	});
});
