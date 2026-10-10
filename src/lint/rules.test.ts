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

	it('README.md says what each rule means in the words the registry holds', () => {
		// The registry's `meaning` is the first line of a rule's page and what
		// the MCP server explains a rule with, so the README's column is held to it.
		const rows = read('README.md').matchAll(
			/^\| (JEV\d{3}) \| [^|]+ \| [^|]+ \| (.+) \|$/gm,
		);
		const documented = new Map([...rows].map((row) => [row[1], row[2]]));
		for (const code of RULE_CODES)
			expect(documented.get(code), code).toBe(RULES[code].meaning);
	});

	it('keys every rule by its own code', () => {
		for (const code of RULE_CODES) expect(RULES[code].code).toBe(code);
	});

	it('points every rule about a question at a vendor page', () => {
		// JEV010 is about this tool's own comments, which no vendor page covers.
		for (const code of RULE_CODES.filter((code) => code !== 'JEV010'))
			expect(RULES[code].docs).toMatch(/^https:\/\/docs\.typesafe\.ai\//);
	});
});
