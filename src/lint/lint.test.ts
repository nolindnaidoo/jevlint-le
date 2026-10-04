import { describe, expect, it } from 'vitest';
import type { LintOptions, ReportedFinding } from '../types';
import { DEFAULT_OPTIONS, lintText } from './lint';

function codes(
	text: string,
	options: LintOptions = DEFAULT_OPTIONS,
): ReadonlyArray<string> {
	return lintText(text, options).findings.map((finding) => finding.code);
}

function request(questions: string, model = 'jev-1.13.0'): string {
	return `{ "state": "s", "model": "${model}", "questions": { ${questions} } }`;
}

function finding(text: string, code: string): ReportedFinding {
	const found = lintText(text).findings.find(
		(candidate) => candidate.code === code,
	);
	if (!found) throw new Error(`no ${code} finding`);
	return found;
}

function apply(text: string, target: ReportedFinding): string {
	const edit = target.fix?.edits[0];
	if (!edit) throw new Error('finding has no fix');
	return text.slice(0, edit.span.start) + edit.text + text.slice(edit.span.end);
}

const CLEAN_NOUL = `"deadline": { "type": "noul", "instructions": "Does the note name a deadline?" }`;
const CLEAN_CHOICE = `"bench": { "type": "choice", "instructions": "Which bench?", "criteria": { "wheels": "Wheel work", "brakes": "Brake work", "other": "Anything else" } }`;
const CLEAN_SCORE = `"mood": { "type": "score", "instructions": "How put out?", "criteria": ["Relaxed about it", "Clearly annoyed", "Says they will go elsewhere"] }`;

describe('lintText', () => {
	it('reports nothing on a well-formed request', () => {
		const result = lintText(
			request(`${CLEAN_NOUL}, ${CLEAN_CHOICE}, ${CLEAN_SCORE}`),
		);
		expect(result.findings).toEqual([]);
		expect(result.questionCount).toBe(3);
		expect(result.unreadableCount).toBe(0);
	});

	it('returns early on a file that cannot hold a question', () => {
		expect(lintText('const a = { type: "x" };')).toMatchObject({
			findings: [],
			questionCount: 0,
		});
	});

	it('ignores objects that merely have a type field', () => {
		expect(codes(`const action = { type: 'choice', payload: 1 };`)).toEqual([]);
	});
});

describe('JEV000 unreadable', () => {
	it('fires when instructions are built at runtime, and counts the question', () => {
		const result = lintText(
			`const q = { questions: { a: { type: 'noul', instructions: build() } } };`,
		);
		expect(result.findings.map((found) => found.code)).toEqual(['JEV000']);
		expect(result.unreadableCount).toBe(1);
	});

	it('fires when criteria hold a spread, and skips the option rules', () => {
		expect(
			codes(
				`const q = { type: 'choice', instructions: 'Which?', criteria: { ...teams } };`,
			),
		).toEqual(['JEV000']);
	});

	it('fires when a whole map entry is a runtime value', () => {
		expect(
			codes(
				`const r = { questions: { a: { type: 'noul', instructions: 'Is it?' }, b: makeQuestion() } };`,
			),
		).toEqual(['JEV000']);
	});

	it('still counts the unreadable question when the hint is switched off', () => {
		const options = { ...DEFAULT_OPTIONS, rules: { JEV000: 'off' as const } };
		const result = lintText(
			`const q = { type: 'noul', instructions: build() };`,
			options,
		);
		expect(result.findings).toEqual([]);
		expect(result.unreadableCount).toBe(1);
	});
});

describe('JEV001 unpinned-model', () => {
	it.each(['jev-latest', 'jev-preview'])('fires on the alias %s', (alias) => {
		expect(codes(request(CLEAN_NOUL, alias))).toEqual(['JEV001']);
	});

	it('does not fire on a versioned id', () => {
		expect(codes(request(CLEAN_NOUL, 'jev-1.13.0'))).toEqual([]);
	});

	it('does not fire when the model is a runtime value', () => {
		expect(
			codes(
				`const r = { model: MODEL, questions: { a: { type: 'noul', instructions: 'Is it?' } } };`,
			),
		).toEqual([]);
	});

	it('fires on a client constructed with an alias', () => {
		expect(
			codes(`const client = new TypeSafeClient({ model: 'jev-latest' });`),
		).toEqual(['JEV001']);
	});
});

describe('JEV002 choice-option-limit', () => {
	const options = (count: number) =>
		Array.from({ length: count }, (_, i) => `"o${i}": null`).join(', ');

	it('fires above 255 options', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": { ${options(255)}, "other": null } }`,
				),
			),
		).toEqual(['JEV002']);
	});

	it('does not fire at exactly 255', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": { ${options(254)}, "other": null } }`,
				),
			),
		).toEqual([]);
	});
});

describe('JEV003 score-level-limit', () => {
	const levels = (count: number) =>
		[
			'Nothing works',
			'Starts then stops',
			'Runs with faults',
			'Runs with one fault',
			'Runs but is slow',
			'Runs at normal speed',
			'Runs faster than expected',
			'Handles double the load',
			'Handles every load tried',
			'Has never failed',
			'Cannot be made to fail',
		]
			.slice(0, count)
			.map((level) => `"${level}"`)
			.join(', ');

	it('fires above 10 levels, and calls one level informational', () => {
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": [${levels(11)}] }`,
				),
			),
		).toEqual(['JEV003']);
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": [${levels(1)}] }`,
				),
			),
		).toEqual(['JEV009']);
	});

	it('does not fire at 2 or 10', () => {
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": [${levels(2)}] }`,
				),
			),
		).toEqual([]);
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": [${levels(10)}] }`,
				),
			),
		).toEqual([]);
	});

	it('does not call a spread array too short', () => {
		expect(
			codes(
				`const q = { type: 'score', instructions: 'Rate', criteria: [...LEVELS] };`,
			),
		).toEqual(['JEV000']);
	});
});

describe('JEV004 no-fallback-option', () => {
	const bare = `"bench": { "type": "choice", "instructions": "Which bench?", "criteria": { "wheels": "Wheel work", "brakes": "Brake work" } }`;

	it('fires on a Choice with no fallback', () => {
		expect(codes(request(bare))).toEqual(['JEV004']);
	});

	it.each(['other', 'none_of_the_above', 'Not-Stated', 'UNKNOWN'])(
		'accepts %s as a fallback',
		(name) => {
			expect(
				codes(
					request(
						`"q": { "type": "choice", "instructions": "Which?", "criteria": { "a": null, "${name}": null } }`,
					),
				),
			).toEqual([]);
		},
	);

	it('honours a configured fallback list', () => {
		const text = request(
			`"q": { "type": "choice", "instructions": "Which?", "criteria": { "a": null, "misc": null } }`,
		);
		expect(codes(text)).toEqual(['JEV004']);
		expect(
			codes(text, { ...DEFAULT_OPTIONS, fallbackOptions: ['misc'] }),
		).toEqual([]);
	});

	it('fixes multi-line JSON without breaking it', () => {
		const text = `{\n  "questions": {\n    "team": {\n      "type": "choice",\n      "instructions": "Which team?",\n      "criteria": {\n        "billing": "Payments",\n        "technical": "Bugs"\n      }\n    }\n  }\n}`;
		const fixed = apply(text, finding(text, 'JEV004'));
		expect(Object.keys(JSON.parse(fixed).questions.team.criteria)).toEqual([
			'billing',
			'technical',
			'other',
		]);
		expect(fixed).toContain(
			'\n        "other": "Fits none of the other options"\n',
		);
		expect(codes(fixed)).toEqual([]);
	});

	it('fixes TypeScript with a trailing comma, keeping the comma style', () => {
		const text = `const q = {\n\ttype: 'choice',\n\tinstructions: 'Which?',\n\tcriteria: {\n\t\ta: 'A',\n\t\tb: 'B',\n\t},\n};`;
		const fixed = apply(text, finding(text, 'JEV004'));
		expect(fixed).toContain(
			"\t\tb: 'B',\n\t\tother: 'Fits none of the other options',\n\t},",
		);
		expect(codes(fixed)).toEqual([]);
	});

	it('fixes an inline object', () => {
		const text = `const q = { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } };`;
		const fixed = apply(text, finding(text, 'JEV004'));
		expect(fixed).toContain(
			"{ a: null, b: null, other: 'Fits none of the other options' }",
		);
	});

	it('offers no fix when a comment follows the last option', () => {
		const text = `const q = { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null /* last */ } };`;
		expect(finding(text, 'JEV004').fix).toBeUndefined();
	});
});

describe('JEV005 duplicate', () => {
	it('fires on a repeated question id', () => {
		expect(codes(request(`${CLEAN_NOUL}, ${CLEAN_NOUL}`))).toEqual(['JEV005']);
	});

	it('fires on a repeated option and a repeated level', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": { "a": null, "a": null, "other": null } }`,
				),
			),
		).toEqual(['JEV005']);
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": ["Calm", "Angry", "Calm"] }`,
				),
			),
		).toEqual(['JEV005']);
	});

	it('does not fire on the same id in two separate requests', () => {
		expect(
			codes(
				`const a = ${request(CLEAN_NOUL)}; const b = ${request(CLEAN_NOUL)};`,
			),
		).toEqual([]);
	});
});

describe('JEV006 criteria-shape', () => {
	it('fires on a Choice given an array and a Score given a map', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": ["a", "b"] }`,
				),
			),
		).toEqual(['JEV006']);
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": { "low": "a", "high": "b" } }`,
				),
			),
		).toEqual(['JEV006']);
	});

	it('fires on a Choice or Score with no criteria', () => {
		expect(
			codes(request(`"q": { "type": "choice", "instructions": "Which?" }`)),
		).toEqual(['JEV006']);
		expect(
			codes(
				request(
					`${CLEAN_NOUL}, "q": { "type": "score", "instructions": "Rate" }`,
				),
			),
		).toEqual(['JEV006']);
	});

	it('fires on Noul criteria keys other than true and false', () => {
		expect(
			codes(
				request(
					`"q": { "type": "noul", "instructions": "Is it?", "criteria": { "yes": "a", "no": "b" } }`,
				),
			),
		).toEqual(['JEV006', 'JEV006']);
	});

	it('accepts a Noul with documented criteria or none', () => {
		expect(
			codes(
				request(
					`"q": { "type": "noul", "instructions": "Is it?", "criteria": { "true": "a", "false": "b" } }`,
				),
			),
		).toEqual([]);
		expect(codes(request(CLEAN_NOUL))).toEqual([]);
	});

	it('says nothing about criteria it cannot read', () => {
		expect(
			codes(
				`const q = { type: 'choice', instructions: 'Which?', criteria: TEAMS };`,
			),
		).toEqual(['JEV000']);
	});
});

describe('JEV007 invalid-question', () => {
	it('fires on an unknown type beside a valid question', () => {
		expect(
			codes(
				request(
					`${CLEAN_NOUL}, "q": { "type": "chioce", "instructions": "Which?" }`,
				),
			),
		).toEqual(['JEV007']);
	});

	it('fires on a missing type and on empty instructions', () => {
		expect(
			codes(request(`${CLEAN_NOUL}, "q": { "instructions": "Which?" }`)),
		).toEqual(['JEV007']);
		expect(
			codes(request(`"q": { "type": "noul", "instructions": "  " }`)),
		).toEqual(['JEV007']);
	});

	it('says nothing about missing instructions, which the SDK allows', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "criteria": { "yes": null, "no": null, "other": null } }`,
				),
			),
		).toEqual([]);
	});

	it('reads the Vercel AI SDK boolean type as a Noul', () => {
		const text = `const r = { questions: { refund: { type: 'boolean', instructions: 'Is it not unpaid?' }, team: { type: 'choice', instructions: 'Which?', criteria: { a: null, other: null } } } };`;
		expect(codes(text)).toEqual(['JEV101']);
	});

	it('accepts structured instructions', () => {
		expect(
			codes(
				request(
					`"q": { "type": "noul", "instructions": { "question": "Same person as \`dup\`?", "dup": { "name": "J" } } }`,
				),
			),
		).toEqual([]);
	});
});

describe('code that only looks like a question', () => {
	const sdk = `import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';\n`;

	it('ignores a local helper that shares a name with one the file did not import', () => {
		const text = `import { TypeSafeClient } from '@typesafe-ai/sdk';\nconst q = noul('Was it passing?', ['regression', 'It passed before'], ['flag', 'It failed before']);`;
		expect(lintText(text).questionCount).toBe(0);
	});

	it('ignores method calls, method declarations and signatures named like a helper', () => {
		const text = `${sdk}class Answers {\n\tchoice(name: string): string | undefined { return this.read(name)?.choice; }\n\tasync score(params: Rubric): Promise<number> { return 1; }\n}\ninterface Reader { noul(key: string): number | undefined; }\nconst picked = answers.choice('team');`;
		expect(lintText(text).questionCount).toBe(0);
	});

	it('still reads a helper call inside a conditional', () => {
		const text = `${sdk}const q = { questions: { a: strict ? choice('Which?', { a: null, other: null }) : noul('Is it?') } };`;
		expect(lintText(text).questionCount).toBe(2);
		const direct = `${sdk}const q = strict ? choice('Which?', { a: null }) : undefined;`;
		expect(codes(direct)).toEqual(['JEV009']);
	});

	it('does not call criteria missing when a spread may supply them', () => {
		expect(
			codes(`const q = { type: 'choice', instructions: 'Which?', ...rest };`),
		).toEqual([]);
	});

	it("does not call criteria missing on another client's question shape", () => {
		const text = `const state = [{ key: 'a', type: 'score', instructions: 'How important?', options: [] }, { key: 'b', type: 'noul', instructions: '', options: [] }];`;
		expect(codes(text)).toEqual([]);
	});

	it('accepts a Noul whose criteria are an empty array', () => {
		expect(
			codes(
				request(
					`"q": { "type": "noul", "instructions": "Is it?", "criteria": [] }`,
				),
			),
		).toEqual([]);
	});
});

describe('where findings point', () => {
	const underlined = (text: string, code: string): string => {
		const found = finding(text, code);
		return text.slice(found.span.start, found.span.end);
	};

	it('underlines the unknown type itself, not the question id', () => {
		const text = request(
			`${CLEAN_NOUL}, "q": { "type": "chioce", "instructions": "Which?" }`,
		);
		expect(underlined(text, 'JEV007')).toBe('"chioce"');
	});

	it('underlines the criteria key when the criteria have the wrong shape', () => {
		const text = request(
			`"q": { "type": "score", "instructions": "Rate", "criteria": { "low": "a", "high": "b" } }`,
		);
		expect(underlined(text, 'JEV006')).toBe('"criteria"');
	});

	it('underlines the question id when the criteria are missing altogether', () => {
		const text = request(`"q": { "type": "choice", "instructions": "Which?" }`);
		expect(underlined(text, 'JEV006')).toBe('"q"');
	});

	it('underlines the helper name when a helper call has the wrong shape', () => {
		const text = `import { choice } from '@typesafe-ai/sdk';\nconst q = choice('Which?', ['a', 'b']);`;
		expect(underlined(text, 'JEV006')).toBe('choice');
	});
});

describe('mechanical fixes', () => {
	const fixed = (text: string, code: string) =>
		apply(text, finding(text, code));

	it('renames yes and no criteria to true and false, one key at a time', () => {
		const text = request(
			`"q": { "type": "noul", "instructions": "Is it?", "criteria": { "yes": "a", "No": "b" } }`,
		);
		const once = fixed(text, 'JEV006');
		expect(once).toContain('"true": "a"');
		expect(fixed(once, 'JEV006')).toContain('"false": "b"');
		expect(codes(fixed(once, 'JEV006'))).toEqual([]);
	});

	it('offers no rename for a key it cannot map', () => {
		const text = request(
			`"q": { "type": "noul", "instructions": "Is it?", "criteria": { "maybe": "a" } }`,
		);
		expect(finding(text, 'JEV006').fix).toBeUndefined();
	});

	it('corrects a type that is one real type away, keeping the quotes', () => {
		const json = request(
			`${CLEAN_NOUL}, "q": { "type": "nuol", "instructions": "Is it?" }`,
		);
		expect(fixed(json, 'JEV007')).toContain('"type": "noul"');
		const ts = `const r = { questions: { a: { type: 'noul', instructions: 'Is it?' }, b: { type: 'chioce', instructions: 'Which?' } } };`;
		expect(fixed(ts, 'JEV007')).toContain("type: 'choice'");
	});

	it('offers no correction for a type that resembles none', () => {
		const text = request(
			`${CLEAN_NOUL}, "q": { "type": "ranking", "instructions": "Order them" }`,
		);
		expect(finding(text, 'JEV007').fix).toBeUndefined();
	});

	it('pins an alias and says when that version was current', () => {
		const text = request(CLEAN_NOUL, 'jev-latest');
		const pin = finding(text, 'JEV001');
		expect(pin.fix?.title).toMatch(
			/^Pin to 'jev-\d+\.\d+\.\d+', the version current on \d{4}-\d{2}-\d{2}$/,
		);
		expect(codes(apply(text, pin))).toEqual([]);
	});

	it('turns a Score map into an array, keeping every description', () => {
		const text = `{\n  "questions": {\n    "q": {\n      "type": "score",\n      "instructions": "How worn?",\n      "criteria": {\n        "light": "One fault, otherwise looked after",\n        "heavy": "Several faults left a while"\n      }\n    }\n  }\n}`;
		const out = fixed(text, 'JEV006');
		expect(JSON.parse(out).questions.q.criteria).toEqual([
			'One fault, otherwise looked after',
			'Several faults left a while',
		]);
		expect(out).toContain(
			'"criteria": [\n        "One fault, otherwise looked after",\n        "Several faults left a while"\n      ]',
		);
		expect(codes(out)).toEqual([]);
	});

	it('turns a Choice array into a map on one line', () => {
		const text = `const r = { questions: { q: { type: 'choice', instructions: 'Which?', criteria: ['a', 'b', 'other'] } } };`;
		const out = fixed(text, 'JEV006');
		expect(out).toContain("criteria: { 'a': null, 'b': null, 'other': null }");
		expect(codes(out)).toEqual([]);
	});

	it('offers no reshape when a value was built at runtime', () => {
		const text = `const r = { questions: { a: { type: 'noul', instructions: 'Is it?' }, q: { type: 'score', instructions: 'Rate', criteria: { low: lowText, high: 'High' } } } };`;
		expect(finding(text, 'JEV006').fix).toBeUndefined();
	});
});

describe('JEV008 numeric-levels', () => {
	it('fires when every level is a bare number', () => {
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate 0 to 2", "criteria": ["0", "1", "2"] }`,
				),
			),
		).toEqual(['JEV008']);
		expect(
			codes(
				`const q = { type: 'score', instructions: 'Rate', criteria: [0, 1, 2] };`,
			),
		).toEqual(['JEV008']);
	});

	it('does not fire when levels are described', () => {
		expect(codes(request(CLEAN_SCORE))).toEqual([]);
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": ["0", "Somewhat broken", "2"] }`,
				),
			),
		).toEqual([]);
	});
});

describe('levels that differ only by a number', () => {
	it('are read as a ladder of one word, when that rule is switched on', () => {
		expect(
			codes(
				request(
					`"q": { "type": "score", "instructions": "Rate", "criteria": ["Level 1", "Level 2", "Level 3"] }`,
				),
				{ ...DEFAULT_OPTIONS, rules: { JEV110: 'warning' } },
			),
		).toEqual(['JEV110']);
	});
});

describe('what a question lacks, outside a request', () => {
	it('is not reported for a lone object, which may be a template or a mock', () => {
		expect(
			codes(`const q = { type: 'choice', instructions: 'Which?' };`),
		).toEqual([]);
		// A function that builds a question from its parameters is not a question.
		expect(
			codes(
				`const build = (instructions) => ({ type: 'score', instructions });`,
			),
		).toEqual([]);
		expect(
			codes(`const q = { type: 'score', instructions: makeText() };`),
		).toEqual(['JEV000']);
	});

	it('is reported for an entry in a questions map', () => {
		expect(
			codes(
				`const r = { questions: { a: { type: 'noul', instructions: 'Is it?' }, b: { type: 'score', instructions: 'Rate it', min: 1, max: 10 } } };`,
			),
		).toEqual(['JEV006']);
	});

	it('is not concluded from a template slot', () => {
		expect(
			codes(
				request(
					`"a": { "type": "noul", "instructions": "Is it?" }, "q": { "type": "choice", "instructions": "$question", "criteria": "$options" }`,
				),
			),
		).toEqual([]);
	});

	it("makes no shape claim when another client's fields are present", () => {
		expect(
			codes(
				`const r = { questions: { a: { type: 'noul', instructions: 'Is it?' }, b: { type: 'choice', instructions: 'Which way?', options: ['LEFT', 'RIGHT'], criteria: ['be decisive'] } } };`,
			),
		).toEqual([]);
	});
});

describe('JEV009 too-few-options', () => {
	it('fires on one option and on none', () => {
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": { "a": null } }`,
				),
			),
		).toEqual(['JEV009']);
		expect(
			codes(
				request(
					`"q": { "type": "choice", "instructions": "Which?", "criteria": {} }`,
				),
			),
		).toEqual(['JEV009']);
	});
});

describe('sources', () => {
	it('reads SDK helper calls when the SDK is imported', () => {
		const text = `import { choice, noul, score } from '@typesafe-ai/sdk';\nconst questions = {\n  team: choice('Which team?', { billing: null, technical: null }),\n  urgent: noul('Is it urgent?'),\n  mood: score('How angry?', ['1', '2']),\n};`;
		expect(codes(text)).toEqual(['JEV004', 'JEV008']);
		expect(lintText(text).questionCount).toBe(3);
	});

	it('ignores a function named like a helper when the SDK is not imported', () => {
		expect(codes(`const pick = choice('Which team?', ['a', 'b']);`)).toEqual(
			[],
		);
	});

	it('finds a request passed to a call inside a callback', () => {
		const text = `export const run = async (state) => handler({ go: () => client.systemOne({ state, model: 'jev-latest', questions: { team: { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } } } }) });`;
		expect(codes(text)).toEqual(['JEV001', 'JEV004']);
	});

	it('reads oxlint-plugin-jev rules as Noul questions', () => {
		const text = `{ "jsPlugins": ["oxlint-plugin-jev"], "rules": { "jev/ask": ["error", { "model": "jev-latest", "rules": [ { "id": "a", "target": "call", "question": "Does this log personal data?", "cutoff": 0.8 }, { "id": "a", "target": "file", "question": "", "cutoff": 0.6 } ] }] } }`;
		expect(codes(text)).toEqual(['JEV001', 'JEV005', 'JEV007']);
		expect(lintText(text).questionCount).toBe(2);
	});
});

describe('suppression', () => {
	const bare = `{ type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } }`;

	it('silences the next line, the same line and the whole file', () => {
		expect(
			codes(`// jevlint-le-disable-next-line JEV004\nconst q = ${bare};`),
		).toEqual([]);
		expect(codes(`const q = ${bare}; // jevlint-le-disable-line`)).toEqual([]);
		expect(
			codes(`/* jevlint-le-disable JEV004 */\n\n\nconst q = ${bare};`),
		).toEqual([]);
	});

	it('leaves other rules and other lines alone', () => {
		expect(
			codes(`// jevlint-le-disable-next-line JEV001\nconst q = ${bare};`),
		).toEqual(['JEV004']);
		expect(
			codes(`// jevlint-le-disable-next-line JEV004\n\nconst q = ${bare};`),
		).toEqual(['JEV004']);
	});

	it('drops a finding listed in the ignore setting', () => {
		const text = request(
			`"team": { "type": "choice", "instructions": "Which?", "criteria": { "a": null, "b": null } }`,
		);
		expect(
			codes(text, { ...DEFAULT_OPTIONS, ignore: ['JEV004:team'] }),
		).toEqual([]);
		expect(
			codes(text, { ...DEFAULT_OPTIONS, ignore: ['JEV004:other'] }),
		).toEqual(['JEV004']);
	});

	it('applies a configured severity and switches a rule off', () => {
		const text = request(
			`"team": { "type": "choice", "instructions": "Which?", "criteria": { "a": null, "b": null } }`,
		);
		expect(lintText(text).findings[0]?.severity).toBe('info');
		expect(
			lintText(text, { ...DEFAULT_OPTIONS, rules: { JEV004: 'error' } })
				.findings[0]?.severity,
		).toBe('error');
		expect(
			codes(text, { ...DEFAULT_OPTIONS, rules: { JEV004: 'off' } }),
		).toEqual([]);
	});
});
