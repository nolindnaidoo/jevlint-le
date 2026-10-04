import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, lintText, readQuestions } from '../lint/lint';
import type { Fix, Syntax } from '../types';

const shape = (text: string, syntax: Syntax) =>
	readQuestions(text, syntax).questions.map((q) =>
		[q.id ?? '-', q.type, q.open ? 'open' : '', q.inRequest ? 'request' : '']
			.filter(Boolean)
			.join(' '),
	);
const codes = (text: string, syntax: Syntax) =>
	lintText(text, DEFAULT_OPTIONS, syntax).findings.map(
		(finding) => finding.code,
	);

function apply(text: string, fix: Fix | undefined): string {
	if (!fix) throw new Error('no fix offered');
	return [...fix.edits]
		.sort((a, b) => b.span.start - a.span.start)
		.reduce(
			(out, edit) =>
				out.slice(0, edit.span.start) + edit.text + out.slice(edit.span.end),
			text,
		);
}

describe('Rust', () => {
	const rust = (text: string) => shape(text, 'rust');

	it('reads the JSON inside json!, with the request around it', () => {
		const text = `let body = serde_json::json!({
    "model": "jev-latest",
    "state": state,
    "questions": {
        "late": { "type": "noul", "instructions": "Is it late?" },
        "team": { "type": "choice", "instructions": "Which team?", "criteria": { "a": null, "b": null } },
    }
});`;
		expect(rust(text)).toEqual(['late noul request', 'team choice request']);
		expect(codes(text, 'rust')).toEqual(['JEV001', 'JEV004']);
	});

	it('is not fooled by lifetimes, characters, raw strings or comments', () => {
		const text = `// { "type": "noul", "instructions": "no" }
fn pick<'a>(x: &'a str, c: char) -> &'a str { if c == '{' { x } else { "}" } }
let s = r##"a "# b"##;
let q = json!({ "questions": { "a": { "type": "noul", "instructions": "Is it?" } } });`;
		expect(rust(text)).toEqual(['a noul request']);
	});

	it('reads a struct or variant named for a question type', () => {
		const text = `let q = Question::Choice {
    instructions: "Which team?".to_string(),
    criteria: BTreeMap::from([("billing".to_owned(), Some("Charges".to_owned())), ("other".to_owned(), None)]),
};
let s = Score { instructions: String::from("How bad?"), criteria: vec!["Mild".into(), "Severe".into()] };`;
		expect(rust(text)).toEqual(['- choice', '- score']);
		expect(codes(text, 'rust')).toEqual([]);
	});

	it('reads a list of pairs as the map it becomes', () => {
		const text = `let q = Question::Choice { instructions: "Which?".into(), criteria: vec![("a".to_string(), "A".to_string()), ("b".to_string(), "B".to_string())] };`;
		expect(readQuestions(text, 'rust').questions[0]?.criteria).toMatchObject({
			kind: 'object',
			props: [{ key: 'a' }, { key: 'b' }],
		});
	});

	it.each([
		[
			'a pattern',
			'match q { Question::Noul { instructions, criteria } => 1, Question::Choice { instructions: i, .. } => 2 }',
		],
		[
			'a type definition',
			'enum Question { Noul { instructions: Value, criteria: Option<(Value, Value)> } }\nstruct Score { instructions: String }',
		],
		[
			'an answer',
			'let a = Answer::Noul { noul: 0.9 };\nlet b = Answer { kind: "choice".into(), choice: Some("x".into()) };',
		],
		[
			'a block that returns a struct',
			'fn f(x: &str) -> Noul { Noul { instructions: x.into() } }',
		],
	])('reads no question from %s', (_name, text) => {
		expect(rust(text)).toEqual([]);
	});

	it("does not judge criteria held in the project's own type", () => {
		const text = `let q = Question::Noul { instructions: "Is it late?".into(), criteria: NoulCriteria { yes: "Late".into(), no: "On time".into() } };`;
		expect(rust(text)).toEqual(['- noul']);
		expect(codes(text, 'rust')).toEqual(['JEV000']);
	});

	it('takes only the wording from a constructor, since the rest varies by project', () => {
		const text = `ask.add("items", Question::noul("Does the order hold more than 3 items?", "yes", "no"));`;
		expect(rust(text)).toEqual(['- noul open']);
		expect(codes(text, 'rust')).toEqual(['JEV102']);
	});

	it('reads a type given as a constant and a field called kind', () => {
		const text = `let q = Question { kind: QType::Score, instructions: json!("Rate it"), criteria: Some(json!(["1", "2"])) };`;
		expect(rust(text)).toEqual(['- score']);
		expect(codes(text, 'rust')).toEqual(['JEV008']);
	});
});

describe('Go', () => {
	const go = (text: string) => shape(text, 'go');

	it('reads a request written as nested maps', () => {
		const text = `payload := map[string]any{
	"model": "jev-latest",
	"state": state,
	"questions": map[string]any{
		"late": map[string]any{"type": "noul", "instructions": "Is it late?"},
		"mood": map[string]interface{}{"type": "score", "instructions": "How upset?", "criteria": []string{"1", "2", "3"}},
	},
}`;
		expect(go(text)).toEqual(['late noul request', 'mood score request']);
		expect(codes(text, 'go')).toEqual(['JEV001', 'JEV008']);
	});

	it('reads structs, with or without the type written out', () => {
		const text = `questions := map[string]Question{
	"team": {Type: "choice", Instructions: "Which team?", Criteria: map[string]string{"billing": "Charges", "other": "Anything else"}},
	"sev":  {Type: KindScore, Instructions: "How bad?", Criteria: []string{"Mild", "Severe"}},
	"late": typesafe.Noul{Instructions: "Is it late?"},
}`;
		expect(go(text)).toEqual([
			'team choice request',
			'sev score request',
			'late noul request',
		]);
		expect(codes(text, 'go')).toEqual([]);
	});

	it('is not fooled by raw strings, runes, comments or blocks', () => {
		const text = `// {"type": "noul", "instructions": "no"}
func f(c rune) string { if c == '{' { return "}" }; for _, choice := range choices { use(choice) }; return \`{\` }
var q = map[string]any{"questions": map[string]any{"a": map[string]any{"type": "noul", "instructions": "Is it?"}}}`;
		expect(go(text)).toEqual(['a noul request']);
	});

	it.each([
		[
			'an answer',
			'a := Answer{Type: "choice", Choice: "x", Confidence: 0.9}\nb := ChoiceAnswer{Choice: "x"}',
		],
		[
			"a struct with another client's fields",
			'q := SystemOneNoul{Type: "noul", Prompt: "Can this be rolled back?"}',
		],
		[
			'a type definition',
			'type Noul struct { Instructions string; Criteria map[string]string }',
		],
	])('reads no question from %s', (_name, text) => {
		expect(go(text)).toEqual([]);
	});

	it('says nothing about a struct whose type is in its own name', () => {
		const text = `qs := map[string]decider.Question{"churn": decider.BooleanQuestion{Instructions: "Will the customer cancel?"}}`;
		expect(codes(text, 'go')).toEqual([]);
	});

	it("does not judge criteria held in the project's own type", () => {
		const text = `q := Score{Instructions: "Risk?", Criteria: ScoreCriteria{levels}}`;
		expect(codes(text, 'go')).toEqual(['JEV000']);
	});

	it('marks a struct with fields of its own as open', () => {
		const text = `q := typesafe.Choice{Instructions: "Which?", Criteria: map[string]string{"a": "A", "other": "Else"}, Threshold: 0.6}`;
		expect(go(text)).toEqual(['- choice open']);
	});

	it('offers no reshape fix, and still adds a fallback option', () => {
		const list = `q := map[string]any{"questions": map[string]any{"t": map[string]any{"type": "choice", "instructions": "Which?", "criteria": []string{"a", "b"}}}}`;
		const shaped = lintText(list, DEFAULT_OPTIONS, 'go').findings[0];
		expect(shaped?.code).toBe('JEV006');
		expect(shaped?.fix).toBeUndefined();
		const map = `q := map[string]any{"questions": map[string]any{"t": map[string]any{"type": "choice", "instructions": "Which?", "criteria": map[string]string{"a": "A", "b": "B"}}}}`;
		const out = apply(
			map,
			lintText(map, DEFAULT_OPTIONS, 'go').findings[0]?.fix,
		);
		expect(out).toContain(
			`"b": "B", "other": "Fits none of the other options"}`,
		);
		expect(codes(out, 'go')).toEqual([]);
	});
});

describe('string escapes', () => {
	const wording = (text: string, syntax: Syntax) => {
		const node = readQuestions(text, syntax).questions[0]?.instructions;
		return node?.kind === 'string' ? node.value : undefined;
	};

	it('decodes Rust escapes, and joins a line ended with a backslash', () => {
		const text = String.raw`let q = json!({"questions": {"a": {"type": "noul", "instructions": "Caf\u{e9} \x41 \"late\"? \
            Say so.\n"}}});`;
		expect(wording(text, 'rust')).toBe('Café A "late"? Say so.\n');
	});

	it('decodes Go escapes, and takes a raw string as written', () => {
		const text = String.raw`q := map[string]any{"questions": map[string]any{"a": map[string]any{"type": "noul", "instructions": "Café \x41\101 \"late\"?\n"}}}`;
		expect(wording(text, 'go')).toBe('Café AA "late"?\n');
		const raw =
			'q := map[string]any{"questions": map[string]any{"a": map[string]any{"type": "noul", "instructions": `Is \\d+ late?`}}}';
		expect(wording(raw, 'go')).toBe(String.raw`Is \d+ late?`);
	});
});

describe('JSON inside a string', () => {
	it('is read in every language, at its place in the file', () => {
		const json = `{"model":"jev-latest","questions":{"q":{"type":"score","instructions":"Rate","criteria":["1","2"]}}}`;
		const sources: [Syntax, string][] = [
			['rust', `let body = r#"${json}"#;`],
			['go', `body := \`${json}\``],
			['python', `body = '${json}'`],
			['js', `const body = '${json}';`],
		];
		for (const [syntax, text] of sources) {
			const result = lintText(text, DEFAULT_OPTIONS, syntax);
			expect(result.findings.map((finding) => finding.code)).toEqual([
				'JEV001',
				'JEV008',
			]);
			const at = result.findings[0]?.span.start ?? 0;
			expect(text.slice(at, at + 12)).toBe('"jev-latest"');
		}
	});

	it('is left alone when the string has escapes, since positions would not line up', () => {
		const text = `body := "{\\"questions\\":{\\"q\\":{\\"type\\":\\"score\\",\\"instructions\\":\\"Rate\\",\\"criteria\\":[\\"1\\",\\"2\\"]}}}"`;
		expect(codes(text, 'go')).toEqual([]);
	});

	it.each([
		[
			'prose that quotes a question',
			'Return JSON like {"type": "choice", "instructions": "..."}',
		],
		[
			'a response',
			'{"model":"jev-1.13.0","answers":{"q":{"type":"noul","noul":0.9}}}',
		],
	])('reads nothing from %s', (_name, content) => {
		expect(shape(`const s = '${content}';`, 'js')).toEqual([]);
	});

	it('writes a fix as JSON even in a Python file', () => {
		const text = `body = '{"questions":{"t":{"type":"choice","instructions":"Which?","criteria":["a","b"]}}}'`;
		const out = apply(
			text,
			lintText(text, DEFAULT_OPTIONS, 'python').findings[0]?.fix,
		);
		expect(out).toContain('"criteria":{ "a": null, "b": null }');
	});
});
