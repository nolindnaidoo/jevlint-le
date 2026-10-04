import { describe, expect, it } from 'vitest';
import type { Node, ObjectNode } from '../types';
import { readNodes } from './reader';
import { tokenize } from './tokens';

function only(text: string): ObjectNode {
	const nodes = readNodes(text);
	expect(nodes).toHaveLength(1);
	const node = nodes[0] as Node;
	expect(node.kind).toBe('object');
	return node as ObjectNode;
}

function value(node: ObjectNode, key: string): Node {
	const found = node.props.find((prop) => prop.key === key);
	if (!found) throw new Error(`no property ${key}`);
	return found.value;
}

describe('tokenize', () => {
	it('decodes string escapes', () => {
		const [token] = tokenize(String.raw`'a\nA\x42\'c'`);
		expect(token).toMatchObject({
			kind: 'string',
			text: "a\nAB'c",
			quote: "'",
		});
	});

	it('drops line and block comments', () => {
		const kinds = tokenize('a // {\n /* } */ b').map((token) => token.text);
		expect(kinds).toEqual(['a', 'b']);
	});

	it('reads a template without substitutions as a string', () => {
		const [token] = tokenize('`plain`');
		expect(token).toMatchObject({ kind: 'string', text: 'plain', quote: '`' });
	});

	it('keeps a template with a substitution whole, braces and all', () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the input is JavaScript source
		const tokens = tokenize('`a ${ {b: `${c}`}.b } d` x');
		expect(tokens.map((token) => token.kind)).toEqual(['template', 'ident']);
	});

	it('tells a regex from a division', () => {
		expect(tokenize('x = /a{2}/g').map((token) => token.kind)).toContain(
			'regex',
		);
		expect(tokenize('a / b / c').map((token) => token.kind)).not.toContain(
			'regex',
		);
	});

	it('does not let a brace inside a string or regex unbalance the reader', () => {
		const node = only(`({ a: '}', b: /}/, c: 1 })`);
		expect(node.props.map((prop) => prop.key)).toEqual(['a', 'b', 'c']);
	});
});

describe('readNodes', () => {
	it('reads JSON and keeps duplicate keys', () => {
		const node = only('{ "a": 1, "a": 2, "b": [true, null, -3.5] }');
		expect(node.props.map((prop) => prop.key)).toEqual(['a', 'a', 'b']);
		expect(value(node, 'b')).toMatchObject({ kind: 'array', partial: false });
		expect(node.props[0]?.quote).toBe('"');
	});

	it('reads JSONC with comments and trailing commas', () => {
		const node = only('{\n  // why\n  "a": "x", /* b */ "c": "y",\n}');
		expect(node.props.map((prop) => prop.key)).toEqual(['a', 'c']);
	});

	it('joins concatenated string literals', () => {
		const node = only(`x = { a: 'one ' + "two" }`);
		expect(value(node, 'a')).toMatchObject({
			kind: 'string',
			value: 'one two',
		});
	});

	it('sees through `as const` and `satisfies`', () => {
		const node = only(`x = { a: 'v' as const, b: ['p'] satisfies string[] }`);
		expect(value(node, 'a')).toMatchObject({ kind: 'string', value: 'v' });
		expect(value(node, 'b')).toMatchObject({ kind: 'array' });
	});

	it('marks runtime values unreadable instead of guessing', () => {
		const node = only(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the input is JavaScript source
			'x = { a: name, b: `hi ${name}`, c: make(), d: "x".trim(), e }',
		);
		for (const key of ['a', 'c', 'd', 'e'])
			expect(value(node, key).kind).toBe('unreadable');
		// A template keeps its fixed text, with a placeholder for the runtime part.
		expect(value(node, 'b')).toMatchObject({ value: 'hi `…`', slots: true });
	});

	it('marks an object with a spread, a computed key or a method as partial', () => {
		expect(only('x = { ...base, a: 1 }').partial).toBe(true);
		expect(only('x = { [key]: 1, a: 1 }').partial).toBe(true);
		expect(only('x = { a: 1 }').partial).toBe(false);
		const withMethod = only('x = { run() { return 1 }, async go() {}, a: 1 }');
		expect(withMethod.props.map((prop) => prop.key)).toEqual([
			'run',
			'go',
			'a',
		]);
	});

	it('marks an array with a spread as partial', () => {
		const node = only('x = { a: [...rest, "b"] }');
		expect(value(node, 'a')).toMatchObject({ kind: 'array', partial: true });
	});

	it('does not mistake a block for an object, and reads the literals inside it', () => {
		const nodes = readNodes('function f() { const a = 1; return { b: 2 }; }');
		expect(nodes).toHaveLength(1);
		expect((nodes[0] as ObjectNode).props[0]?.key).toBe('b');
	});

	it('finds an object nested inside an unreadable expression', () => {
		const node = only('x = { run: () => client.call({ deep: 1 }) }');
		const run = value(node, 'run');
		expect(run.kind).toBe('unreadable');
		expect(run.kind === 'unreadable' && run.inner).toHaveLength(1);
	});

	it('reads an SDK helper call and its arguments', () => {
		const nodes = readNodes(
			`const q = choice('Which?', { a: null, b: null });`,
		);
		expect(nodes[0]).toMatchObject({ kind: 'call', callee: 'choice' });
		expect(
			nodes[0]?.kind === 'call' && nodes[0].args.map((arg) => arg.kind),
		).toEqual(['string', 'object']);
	});

	it('does not read a helper declaration as a call', () => {
		expect(readNodes('function choice(a, b) { return 1 }')).toHaveLength(0);
	});

	it('survives unterminated input', () => {
		expect(() => readNodes('x = { a: "unterminated\n b: [1, 2')).not.toThrow();
		expect(() => readNodes('`${')).not.toThrow();
		expect(() => readNodes('{ a: {')).not.toThrow();
	});
});
