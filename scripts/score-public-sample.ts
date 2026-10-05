/**
 * Scores the wording rules against a hand-labelled sample of public questions.
 *
 * The labels are in fixtures/<sample>/labels.json. The question text is not
 * in this repo, so it is read from the file `draw-public-sample.ts` wrote.
 * Run this only after the labels are written and committed.
 *
 *   bun scripts/score-public-sample.ts <drawn.json> fixtures/public-sample-2
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintText } from '../src/lint/lint';
import { RULE_CODES, RULES } from '../src/lint/rules';
import type { LintOptions } from '../src/types';

const [drawnPath, sampleDir] = process.argv.slice(2);
if (!drawnPath || !sampleDir) {
	console.error('Usage: bun scripts/score-public-sample.ts <drawn.json> <fixtures/sample-dir>');
	process.exit(2);
}

type Label = { hash: string; defects: string[]; borderline: string[]; skipped: boolean };
const labels: Label[] = JSON.parse(readFileSync(join(sampleDir, 'labels.json'), 'utf8'));
const drawn: { hash: string; id?: string; type: string; instructions: string; criteria?: unknown }[] =
	JSON.parse(readFileSync(drawnPath, 'utf8')).sample;
const text = new Map(drawn.map((question) => [question.hash, question]));

const WORDING = RULE_CODES.filter((code) => code > 'JEV100' && code < 'JEV300');
const allOn: LintOptions = {
	rules: Object.fromEntries(WORDING.map((code) => [code, 'warning'])),
	fallbackOptions: ['other', 'none'],
	ignore: [],
};

const rows = WORDING.map((code) => ({
	code,
	name: RULES[code].name,
	onByDefault: RULES[code].severity !== 'off',
	defects: 0,
	caught: 0,
	fired: 0,
	onBorderline: 0,
	wrong: 0,
	wrongOn: [] as string[],
	missed: [] as string[],
}));
const byCode = new Map(rows.map((row) => [row.code as string, row]));

let read = 0;
for (const label of labels) {
	if (label.skipped) continue;
	const question = text.get(label.hash);
	if (!question) throw new Error(`no text for ${label.hash}: wrong drawn file?`);
	read += 1;
	const request = JSON.stringify({
		questions: { [question.id ?? 'q']: { type: question.type, instructions: question.instructions, ...(question.criteria === undefined ? {} : { criteria: question.criteria }) } },
	});
	const fired = new Set(lintText(request, allOn).findings.map((finding) => finding.code as string));
	for (const row of rows) {
		const isDefect = label.defects.includes(row.code);
		const isBorderline = label.borderline.includes(row.code);
		const didFire = fired.has(row.code);
		if (isDefect) row.defects += 1;
		if (isDefect && didFire) row.caught += 1;
		if (isDefect && !didFire) row.missed.push(label.hash);
		if (didFire) row.fired += 1;
		if (didFire && isBorderline) row.onBorderline += 1;
		if (didFire && !isDefect && !isBorderline) {
			row.wrong += 1;
			row.wrongOn.push(label.hash);
		}
	}
}

const on = rows.filter((row) => row.onByDefault);
const sum = (list: typeof rows, pick: (row: (typeof rows)[number]) => number) =>
	list.reduce((all, row) => all + pick(row), 0);
console.log(JSON.stringify({
	questionsRead: read,
	skipped: labels.length - read,
	withClearDefect: labels.filter((label) => !label.skipped && label.defects.length).length,
	defaultOn: { defects: sum(on, (r) => r.defects), caught: sum(on, (r) => r.caught), findings: sum(on, (r) => r.fired), wrong: sum(on, (r) => r.wrong) },
	allRules: { defects: sum(rows, (r) => r.defects), caught: sum(rows, (r) => r.caught), findings: sum(rows, (r) => r.fired), wrong: sum(rows, (r) => r.wrong) },
	rules: rows,
}, null, 1));
