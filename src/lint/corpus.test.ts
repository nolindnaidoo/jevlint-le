import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RuleCode } from '../types';
import { DEFAULT_OPTIONS, lintText } from './lint';
import { RULE_CODES, RULES } from './rules';

type Entry = Readonly<{ id: string; defects: string[]; question: unknown }>;
type Score = {
	caught: string;
	firedOnGood: string;
	missed: string[];
	falseFirings: string[];
};

const CORPUS = '../../fixtures/corpus';
const corpus: ReadonlyArray<Entry> = JSON.parse(
	readFileSync(new URL(`${CORPUS}/questions.json`, import.meta.url), 'utf8'),
);

const WORDING = RULE_CODES.filter((code) => code > 'JEV100' && code < 'JEV300');
const ALL_ON = {
	...DEFAULT_OPTIONS,
	rules: Object.fromEntries(WORDING.map((code) => [code, 'warning' as const])),
};

// A question with no defect is one a careful author would be content to send.
const good = corpus.filter((entry) => !entry.defects.length);

function fired(entry: Entry): ReadonlySet<string> {
	const text = JSON.stringify({
		state: 's',
		model: 'jev-1.13.0',
		questions: { q: entry.question },
	});
	return new Set(
		lintText(text, ALL_ON).findings.map((finding) => finding.code),
	);
}

function score(code: RuleCode): Score {
	const bad = corpus.filter((entry) => entry.defects.includes(code));
	const missed = bad.filter((entry) => !fired(entry).has(code));
	const falseFirings = good.filter((entry) => fired(entry).has(code));
	return {
		caught: `${bad.length - missed.length} of ${bad.length}`,
		firedOnGood: `${falseFirings.length} of ${good.length}`,
		missed: missed.map((entry) => entry.id),
		falseFirings: falseFirings.map((entry) => entry.id),
	};
}

const scores = Object.fromEntries(
	WORDING.map((code) => [`${code} ${RULES[code].name}`, score(code)]),
);

describe('wording rules against the corpus', () => {
	it('scores what scores.json says, exactly', async () => {
		await expect(`${JSON.stringify(scores, null, 2)}\n`).toMatchFileSnapshot(
			`${CORPUS}/scores.json`,
		);
	});

	// The gate a heuristic passes to be on by default: it catches something,
	// and it fires on no good question. Misses are recorded and do not block,
	// because a quiet rule that catches four of six is worth having and a noisy
	// one is not.
	it.each(WORDING.filter((code) => RULES[code].severity !== 'off'))(
		'%s is on by default only with a catch and no false firing',
		(code) => {
			const result = scores[`${code} ${RULES[code].name}`] as Score;
			expect(result.caught).not.toMatch(/^0 of/);
			expect(result.falseFirings).toEqual([]);
		},
	);

	it('labels every bad question with a wording rule that exists', () => {
		// JEV3xx labels are for the checks Jev itself makes. `lintText` cannot score those.
		const known = new Set<string>(RULE_CODES.filter((code) => code > 'JEV100'));
		const unknown = corpus
			.flatMap((entry) => entry.defects)
			.filter((code) => !known.has(code));
		expect(unknown).toEqual([]);
	});

	it('gives every wording rule something to catch', () => {
		const covered = new Set(corpus.flatMap((entry) => entry.defects));
		expect(WORDING.filter((code) => !covered.has(code))).toEqual([]);
	});

	it('gives every entry its own id', () => {
		const ids = corpus.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
