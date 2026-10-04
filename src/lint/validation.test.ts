import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText } from './lint';
import { RULE_CODES } from './rules';

type Arm = {
	questions?: Record<string, unknown>;
	each?: { question: unknown };
} | null;
type Experiment = { rule: string; name: string; bad: Arm; good: Arm };

const read = (name: string): Experiment[] =>
	JSON.parse(
		readFileSync(
			new URL(`../../fixtures/validation/${name}.json`, import.meta.url),
			'utf8',
		),
	);
// Experiments for the checks Jev itself makes are left out: `lintText` cannot
// run those, so there is nothing offline to hold them to.
const experiments = [
	...read('experiments'),
	...read('hard'),
	...read('encoding'),
	...read('overlap'),
	...read('numbers'),
	...read('criteria'),
].filter((experiment) => experiment.rule < 'JEV300');

// Rules that ship off are validated too. Whether to turn one on is exactly
// what its experiment is for.
const ALL_ON = {
	...DEFAULT_OPTIONS,
	rules: Object.fromEntries(
		RULE_CODES.map((code) => [code, 'warning' as const]),
	),
};

function codes(arm: Arm): ReadonlyArray<string> {
	if (!arm) return [];
	const questions = arm.questions ?? { q: arm.each?.question };
	const text = JSON.stringify({ state: 's', model: 'jev-1.13.0', questions });
	return lintText(text, ALL_ON).findings.map((finding) => finding.code);
}

// The experiments are what gets sent to Jev to learn whether a defect is
// real. They only answer that if the linter and the experiment mean the same
// thing by each rule: it must flag the bad question and pass the fixed one.
describe('validation experiments agree with the rules', () => {
	it.each(experiments)('$rule flags its bad question: $name', (experiment) => {
		expect(codes(experiment.bad)).toContain(experiment.rule);
	});

	it.each(experiments.filter((experiment) => experiment.good))(
		'$rule passes its fixed question: $name',
		(experiment) => {
			expect(codes(experiment.good)).not.toContain(experiment.rule);
		},
	);
});
