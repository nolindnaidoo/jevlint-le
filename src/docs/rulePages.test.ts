import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_CODES } from '../lint/rules';
import { findingsOf, type RuleExamples, renderRulePages } from './rulePages';

const examples: RuleExamples = JSON.parse(
	readFileSync('fixtures/rule-examples.json', 'utf8'),
);
const pages = renderRulePages(readFileSync('README.md', 'utf8'), examples);
const offline = RULE_CODES.filter((code) => !code.startsWith('JEV3'));

describe('the rule examples', () => {
	it('has one for every rule the linter can run offline, and for no other', () => {
		expect(Object.keys(examples).sort()).toEqual([...offline].sort());
	});

	it.each(offline)(
		'%s is flagged in its bad example and not in its good one',
		(code) => {
			const example = examples[code];
			if (!example || 'note' in example) return;
			expect(findingsOf(code, example.bad, example.syntax)).not.toEqual([]);
			expect(findingsOf(code, example.good, example.syntax)).toEqual([]);
		},
	);

	it.each(offline)(
		'%s has a good example with nothing wrong with it at all',
		(code) => {
			const example = examples[code];
			if (!example || 'note' in example) return;
			// A good example that trips another rule teaches the wrong thing.
			for (const other of offline)
				expect(findingsOf(other, example.good, example.syntax), other).toEqual(
					[],
				);
		},
	);
});

describe('the rule pages', () => {
	it('has a page for every rule and an index', () => {
		expect(Object.keys(pages).sort()).toEqual(
			['README.md', ...RULE_CODES.map((code) => `${code}.md`)].sort(),
		);
	});

	it('are on disk as they would be written now', () => {
		// Fails after a rule, its README row or its example changes. Run `bun run docs:rules`.
		for (const [name, text] of Object.entries(pages)) {
			const path = `docs/rules/${name}`;
			expect(existsSync(path), `${path} is missing`).toBe(true);
			expect(readFileSync(path, 'utf8'), path).toBe(text);
		}
		expect(readdirSync('docs/rules').sort()).toEqual(Object.keys(pages).sort());
	});

	it('says what each rule means, taken from the README', () => {
		for (const code of RULE_CODES)
			expect(pages[`${code}.md`]?.split('\n')[2]?.length, code).toBeGreaterThan(
				20,
			);
	});

	it('shows the message the linter really gives for the bad example', () => {
		expect(pages['JEV004.md']).toContain(
			'> This Choice has no fallback option, so',
		);
	});

	it('says which fixes are applied unasked and which are not', () => {
		expect(pages['JEV006.md']).toContain('`--fix` and fix on save mend this');
		expect(pages['JEV004.md']).toContain('never applied by `--fix`');
		expect(pages['JEV005.md']).toContain('There is no automatic fix');
	});

	it('tells a Jev-backed rule apart: what is asked, and the cutoff', () => {
		expect(pages['JEV303.md']).toContain('## What Jev is asked');
		expect(pages['JEV303.md']).toContain('0.75 or more');
		expect(pages['JEV310.md']).toContain('0.15 or more');
		expect(pages['JEV303.md']).not.toContain('## Flagged');
	});
});
