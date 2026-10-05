import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixText } from './fixAll';
import { lintText, syntaxForPath } from './lint';

const OPTIONS = { rules: {}, fallbackOptions: ['other'], ignore: [] };
const codes = (text: string, syntax: 'js' | 'python' = 'js') =>
	lintText(text, OPTIONS, syntax).findings.map((finding) => finding.code);

const BROKEN = `{
  "model": "jev-latest",
  "questions": {
    "late": { "type": "noul", "instructions": "Did it arrive late?", "criteria": { "yes": "After the day promised", "no": "On or before it" } },
    "team": { "type": "choise", "instructions": "Which team?", "criteria": { "billing": "Charges", "technical": "Faults" } },
    "mood": { "type": "score", "instructions": "How upset is the writer?", "criteria": { "low": "Calm", "high": "Furious" } }
  }
}`;

describe('fixing a text', () => {
	it("mends what the API would refuse and leaves the author's choices alone", () => {
		const { text, fixed } = fixText(BROKEN, OPTIONS);
		expect(text).toContain('"true": "After the day promised"');
		expect(text).toContain('"false": "On or before it"');
		expect(text).toContain('"type": "choice"');
		expect(text).toContain('"criteria": ["Calm", "Furious"]');
		expect(fixed).toBe(4);
		// Pinning a model and adding an option change what the request does.
		expect(text).toContain('"jev-latest"');
		expect(text).not.toContain('"other"');
		expect(codes(text)).toContain('JEV001');
		expect(codes(text)).toContain('JEV004');
	});

	it('leaves valid JSON valid', () => {
		expect(() => JSON.parse(fixText(BROKEN, OPTIONS).text)).not.toThrow();
	});

	it('finds nothing more to do the second time', () => {
		const once = fixText(BROKEN, OPTIONS).text;
		expect(fixText(once, OPTIONS)).toEqual({ text: once, fixed: 0 });
	});

	it('changes nothing in a text with nothing to mend', () => {
		const clean = `{ "questions": { "a": { "type": "noul", "instructions": "Is it late?" } } }`;
		expect(fixText(clean, OPTIONS)).toEqual({ text: clean, fixed: 0 });
	});

	it('does not fix a finding that is switched off or silenced', () => {
		const off = { ...OPTIONS, rules: { JEV006: 'off' as const } };
		expect(fixText(BROKEN, off).text).toContain('"yes"');
		const silenced = `// jevlint-le-disable JEV006\nconst q = { type: 'noul', instructions: 'Is it late?', criteria: { yes: 'Late', no: 'On time' } };`;
		expect(fixText(silenced, OPTIONS)).toEqual({ text: silenced, fixed: 0 });
	});

	it('writes each language the way that language is written', () => {
		const python = `from typesafe_sdk import Noul\nq = {"questions": {"a": Noul(instructions="Is it late?", criteria={"yes": "Late", "no": "On time"})}}\n`;
		const { text } = fixText(python, OPTIONS, 'python');
		expect(text).toContain('{"true": "Late", "false": "On time"}');
	});

	it('removes every safely fixable finding from the samples, and breaks none of them', () => {
		const samples = readdirSync('samples').filter((name) =>
			syntaxForPath(name),
		);
		let total = 0;
		for (const name of samples) {
			const syntax = syntaxForPath(name);
			const before = readFileSync(`samples/${name}`, 'utf8');
			const { text, fixed } = fixText(before, OPTIONS, syntax);
			total += fixed;
			const after = lintText(text, OPTIONS, syntax);
			expect(
				after.findings.filter((finding) => finding.fix?.safe),
				name,
			).toEqual([]);
			// A fix must not turn a question the reader could see into one it cannot.
			expect(after.questionCount, name).toBe(
				lintText(before, OPTIONS, syntax).questionCount,
			);
			expect(after.unreadableCount, name).toBe(
				lintText(before, OPTIONS, syntax).unreadableCount,
			);
		}
		expect(total).toBeGreaterThan(0);
	});
});
