/**
 * Writes docs/rules/ from the rule registry and fixtures/rule-examples.json.
 * Run it after changing a rule, its meaning or its example.
 * `src/docs/rulePages.test.ts` fails until it has been run.
 *
 *   bun run docs:rules
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRulePages } from '../src/docs/rulePages';

const root = join(import.meta.dir, '..');
const pages = renderRulePages();
for (const [name, text] of Object.entries(pages))
	writeFileSync(join(root, 'docs', 'rules', name), text);
console.log(`docs/rules: ${Object.keys(pages).length} pages`);
