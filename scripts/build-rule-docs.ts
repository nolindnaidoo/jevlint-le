/**
 * Writes docs/rules/ from the rule registry, the README's tables and
 * fixtures/rule-examples.json. Run it after changing a rule, its README row
 * or its example. `src/docs/rulePages.test.ts` fails until it has been run.
 *
 *   bun run docs:rules
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRulePages } from '../src/docs/rulePages';

const root = join(import.meta.dir, '..');
const pages = renderRulePages(
	readFileSync(join(root, 'README.md'), 'utf8'),
	JSON.parse(readFileSync(join(root, 'fixtures', 'rule-examples.json'), 'utf8')),
);
for (const [name, text] of Object.entries(pages))
	writeFileSync(join(root, 'docs', 'rules', name), text);
console.log(`docs/rules: ${Object.keys(pages).length} pages`);
