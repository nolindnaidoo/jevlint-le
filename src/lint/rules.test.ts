import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RULE_CODES, RULES } from './rules';

const read = (name: string): string =>
	readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');

/** The `| JEV004 | no-fallback-option | info |` rows of a rule table. */
function documented(text: string): ReadonlyArray<string> {
	return [...text.matchAll(/^\| (JEV\d{3}) \| ([a-z-]+) \| (\w+) \|/gm)].map(
		(row) => `${row[1]} ${row[2]} ${row[3]}`,
	);
}

const registered = RULE_CODES.map(
	(code) => `${code} ${RULES[code].name} ${RULES[code].severity}`,
);

describe('rule registry', () => {
	it.each(['SPEC.md', 'README.md'])(
		'%s lists exactly the registered rules, names and default severities',
		(name) => {
			expect(documented(read(name))).toEqual(registered);
		},
	);

	it('keys every rule by its own code', () => {
		for (const code of RULE_CODES) expect(RULES[code].code).toBe(code);
	});

	it('points every rule at a vendor page', () => {
		for (const code of RULE_CODES)
			expect(RULES[code].docs).toMatch(/^https:\/\/docs\.typesafe\.ai\//);
	});
});
