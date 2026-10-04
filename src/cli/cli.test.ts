import { describe, expect, it } from 'vitest';
import { FLAG_NAMES, helpText, parseArgs } from './args';
import type { Files } from './files';
import { EXIT, type Io, run } from './run';

const BAD = `{ "model": "jev-1.13.0", "questions": { "team": { "type": "choice", "instructions": "Which team?", "criteria": { "billing": "Charges", "technical": "Faults" } }, "mood": { "type": "score", "instructions": "How upset?", "criteria": { "low": "Calm" } } } }`;
const CLEAN = `{ "model": "jev-1.13.0", "questions": { "late": { "type": "noul", "instructions": "Did the parcel arrive after the promised day?" } } }`;
const PYTHON = `from typesafe_sdk import Noul\nq = {"questions": {"a": Noul(instructions=f"Is {name} late?")}}\n`;

function disk(tree: Record<string, string>): Files {
	const dirs = new Set(['.']);
	for (const path of Object.keys(tree)) {
		const parts = path.split('/');
		for (let i = 1; i < parts.length; i += 1)
			dirs.add(parts.slice(0, i).join('/'));
	}
	const children = (dir: string) => {
		const prefix = dir === '.' ? '' : `${dir}/`;
		const names = [...Object.keys(tree), ...dirs]
			.filter((path) => path !== '.' && path.startsWith(prefix))
			.map((path) => path.slice(prefix.length).split('/')[0] as string);
		return [...new Set(names)];
	};
	return {
		stat: (path) => {
			if (dirs.has(path)) return { kind: 'dir', size: 0 };
			const text = tree[path];
			return text === undefined
				? undefined
				: { kind: 'file', size: text.length };
		},
		list: children,
		read: (path) => tree[path] ?? '',
	};
}

async function cli(
	args: string[],
	tree: Record<string, string> = {},
	stdin = '',
) {
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = {
		files: disk(tree),
		stdin: async () => stdin,
		lines: async function* () {
			yield* stdin.split('\n');
		},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		version: '9.9.9',
	};
	const status = await run(args, io);
	return { status, out: out.join(''), err: err.join('') };
}

describe('arguments', () => {
	it('lists every flag in the help', () => {
		const help = helpText();
		for (const name of FLAG_NAMES) expect(help).toContain(`  ${name}`);
	});

	it('takes a value after the flag or after an equals sign', () => {
		const spaced = parseArgs(['--format', 'json', 'a.json']);
		const joined = parseArgs(['--format=json', 'a.json']);
		expect(spaced).toEqual(joined);
		expect(spaced.ok && spaced.options.format).toBe('json');
	});

	it.each([
		[['--fromat', 'json'], "Unknown option '--fromat'."],
		[['--format'], '--format needs a value'],
		[['--format', 'xml'], "'xml' is not a format"],
		[['--rule', 'JEV999=off'], "'JEV999' is not a rule code"],
		[['--rule', 'JEV004=loud'], "'loud' is not a level"],
		[['--max-warnings', 'few'], "'few' is not a whole number"],
		[['--quiet=yes'], '--quiet takes no value'],
	])('refuses %j', async (args, reason) => {
		const result = await cli(args, { 'a.json': CLEAN });
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(reason);
		expect(result.out).toBe('');
	});

	it('prints the help and the version', async () => {
		expect((await cli(['--help'])).out).toContain('Usage: jevlint-le');
		expect((await cli(['--version'])).out).toBe('9.9.9\n');
	});
});

describe('a run', () => {
	it('passes a clean file and says what it read', async () => {
		const result = await cli(['a.json'], { 'a.json': CLEAN });
		expect(result.status).toBe(EXIT.passed);
		expect(result.out).toBe(
			'0 findings (0 errors, 0 warnings) in 1 question across 1 file.\n',
		);
	});

	it('fails on an error and prints each finding with its place', async () => {
		const result = await cli(['a.json'], { 'a.json': `\n${BAD}` });
		expect(result.status).toBe(EXIT.failed);
		const lines = result.out.split('\n');
		expect(lines[0]).toMatch(/^a\.json:2:\d+ {2}info {2}JEV004 {2}/);
		expect(lines[1]).toMatch(/^a\.json:2:\d+ {2}error {2}JEV006 {2}/);
		expect(result.out).toContain(
			'2 findings (1 error, 0 warnings) in 2 questions across 1 file.',
		);
	});

	it('passes on warnings until there are more than --max-warnings', async () => {
		const tree = { 'a.json': CLEAN.replace('jev-1.13.0', 'jev-latest') };
		expect((await cli(['a.json'], tree)).status).toBe(EXIT.passed);
		expect((await cli(['a.json', '--max-warnings', '1'], tree)).status).toBe(
			EXIT.passed,
		);
		expect((await cli(['a.json', '--max-warnings', '0'], tree)).status).toBe(
			EXIT.failed,
		);
	});

	it('searches a directory, reads Python, and skips installed packages', async () => {
		const result = await cli(['src'], {
			'src/a.json': CLEAN,
			'src/deep/b.py': PYTHON,
			'src/node_modules/x/c.json': BAD,
			'src/notes.md': BAD,
		});
		expect(result.status).toBe(EXIT.passed);
		expect(result.out).toContain('src/deep/b.py:2:');
		expect(result.out).toContain(
			'in 2 questions across 2 files. 1 question could not be read in full.',
		);
	});

	it('lints the current directory when given no path', async () => {
		const result = await cli([], { 'a.json': CLEAN, 'b.json': CLEAN });
		expect(result.out).toContain('across 2 files');
	});

	it.each([
		[
			'a path that does not exist',
			['gone.json'],
			'No such file or directory: gone.json',
		],
		[
			'a file type it does not read',
			['notes.md'],
			'Not a file type jevlint-le reads: notes.md',
		],
		['a directory with nothing to read', ['empty'], 'No files to lint'],
	])('refuses %s', async (_name, args, reason) => {
		const result = await cli(args, { 'notes.md': BAD, 'empty/readme.md': '' });
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(reason);
	});

	it('names a file it left unread for its size', async () => {
		const result = await cli(['.'], {
			'a.json': CLEAN,
			'big.json': ' '.repeat(1_000_001),
		});
		expect(result.out).toContain(
			'1 file over the size limit not read: big.json.',
		);
	});

	it('reads standard input under the name it is given', async () => {
		const result = await cli(['--stdin-filename', 'q.py'], {}, PYTHON);
		expect(result.out).toContain('q.py:2:');
		const mixed = await cli(['--stdin-filename', 'q.py', 'a.json'], {
			'a.json': CLEAN,
		});
		expect(mixed.err).toContain('cannot be combined with paths');
	});
});

describe('settings', () => {
	const tree = { 'a.json': BAD };

	it('switches a rule with a flag', async () => {
		const result = await cli(
			['a.json', '--rule', 'JEV006=off', '--rule', 'JEV004=error'],
			tree,
		);
		expect(result.out).toContain('error  JEV004');
		expect(result.out).not.toContain('JEV006');
	});

	it('reads a config file, and lets a flag override it', async () => {
		const config = JSON.stringify({
			rules: { JEV006: 'off', JEV004: 'off' },
			ignore: [],
		});
		const fromFile = await cli(['a.json', '--config', 'c.json'], {
			...tree,
			'c.json': config,
		});
		expect(fromFile.out).toContain('0 findings');
		const overridden = await cli(
			['a.json', '--config', 'c.json', '--rule', 'JEV004=warning'],
			{ ...tree, 'c.json': config },
		);
		expect(overridden.out).toContain('warning  JEV004');
	});

	it.each([
		['{ "rule": {} }', "'rule' is not a setting"],
		['{ "rules": { "JEV004": "loud" } }', "rules: 'loud' is not a level"],
		['{ "ignore": "JEV004:team" }', "'ignore' must be a list of strings"],
		['not json', 'it is not valid JSON'],
	])('refuses the config %s', async (config, reason) => {
		const result = await cli(['a.json', '--config', 'c.json'], {
			...tree,
			'c.json': config,
		});
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(`c.json: ${reason}`);
	});

	it('refuses a config file that is not there', async () => {
		expect((await cli(['a.json', '--config', 'c.json'], tree)).err).toContain(
			'No such config file: c.json',
		);
	});

	it('prints errors only when quiet, and still fails on them', async () => {
		const result = await cli(['a.json', '--quiet'], tree);
		expect(result.out).not.toContain('JEV004');
		expect(result.status).toBe(EXIT.failed);
	});
});

describe('the project settings file', () => {
	const OFF = '{ "rules": { "JEV006": "off", "JEV004": "off" } }';

	it('is found near the files and applied, with no flag', async () => {
		const result = await cli(['src'], {
			'src/a.json': BAD,
			'jevlint-le.json': OFF,
		});
		expect(result.out).toContain('0 findings');
		expect(result.status).toBe(EXIT.passed);
	});

	it('is the nearest one, so a folder can have its own', async () => {
		const result = await cli(['.', '--format', 'json'], {
			'jevlint-le.json': OFF,
			'app/jevlint-le.json': '{}',
			'app/a.json': BAD,
			'lib/a.json': BAD,
		});
		const report = JSON.parse(result.out);
		const findings = Object.fromEntries(
			report.files.map((file: { path: string; findings: unknown[] }) => [
				file.path,
				file.findings.length,
			]),
		);
		expect(findings).toMatchObject({ 'app/a.json': 2, 'lib/a.json': 0 });
	});

	it('gives way to --config, and to --rule for the rule it names', async () => {
		const tree = { 'a.json': BAD, 'jevlint-le.json': OFF, 'other.json': '{}' };
		expect(
			(await cli(['a.json', '--config', 'other.json'], tree)).out,
		).toContain('2 findings');
		expect(
			(await cli(['a.json', '--rule', 'JEV004=warning'], tree)).out,
		).toContain('1 finding ');
	});

	it('stops the run when it cannot be used, and names it', async () => {
		const result = await cli(['a.json'], {
			'a.json': BAD,
			'jevlint-le.json': '{ "rule": {} }',
		});
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain("jevlint-le.json: 'rule' is not a setting");
		expect(result.out).toBe('');
	});

	it('applies to text given to the MCP server under a file name', async () => {
		const call = {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: {
				name: 'lint_text',
				arguments: { text: BAD, filename: 'src/a.json' },
			},
		};
		const result = await cli(
			['--mcp'],
			{ 'jevlint-le.json': OFF },
			JSON.stringify(call),
		);
		expect(
			JSON.parse(JSON.parse(result.out).result.content[0].text).totals.counts,
		).toMatchObject({ error: 0, info: 0 });
	});
});

describe('formats', () => {
	const tree = { 'src/a.json': BAD };

	it('writes JSON with one-based positions and the rule behind each finding', async () => {
		const report = JSON.parse(
			(await cli(['src', '--format', 'json'], tree)).out,
		);
		expect(report.totals).toMatchObject({
			files: 1,
			questions: 2,
			unreadable: 0,
			counts: { error: 1, info: 1 },
		});
		expect(report.files[0].findings[0]).toMatchObject({
			code: 'JEV004',
			rule: 'no-fallback-option',
			severity: 'info',
			questionId: 'team',
			line: 1,
			column: BAD.indexOf('"team"') + 1,
		});
		expect(report.files[0].findings[0].docs).toMatch(
			/^https:\/\/docs\.typesafe\.ai\//,
		);
	});

	it('writes GitHub annotations, escaping what GitHub reads as syntax', async () => {
		const result = await cli(['src', '--format', 'github'], {
			'src/a,b.json': BAD,
		});
		const lines = result.out.split('\n');
		expect(lines[0]).toMatch(
			/^::notice file=src\/a%2Cb\.json,line=1,col=\d+,endLine=1,endColumn=\d+,title=JEV004 no-fallback-option::/,
		);
		expect(lines[1]).toMatch(/^::error file=/);
		expect(lines[0]).not.toMatch(/::.*\n/);
	});
});

describe('the MCP server', () => {
	const talk = async (
		messages: unknown[],
		tree: Record<string, string> = {},
	) => {
		const input = messages.map((message) => JSON.stringify(message)).join('\n');
		const result = await cli(['--mcp'], tree, input);
		return result.out
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};
	const call = (id: number, name: string, args: unknown) => ({
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name, arguments: args },
	});
	const body = (reply: { result: { content: { text: string }[] } }) =>
		JSON.parse(reply.result.content[0]?.text ?? 'null');

	it('answers in the protocol version it was asked for, or its newest', async () => {
		const [known, unknown] = await talk([
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2024-11-05' },
			},
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'initialize',
				params: { protocolVersion: '1999-01-01' },
			},
		]);
		expect(known.result).toMatchObject({
			protocolVersion: '2024-11-05',
			serverInfo: { name: 'jevlint-le', version: '9.9.9' },
		});
		expect(unknown.result.protocolVersion).toBe('2025-06-18');
	});

	it('does not answer a notification', async () => {
		const replies = await talk([
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 7, method: 'ping' },
		]);
		expect(replies).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }]);
	});

	it('lints text, taking the language from the file name', async () => {
		const [json, python] = await talk([
			call(1, 'lint_text', { text: BAD }),
			call(2, 'lint_text', { text: PYTHON, filename: 'q.py' }),
		]);
		expect(
			body(json).files[0].findings.map((f: { code: string }) => f.code),
		).toEqual(['JEV004', 'JEV006']);
		expect(body(json).files[0].path).toBe('request.jev.json');
		expect(body(python).totals.unreadable).toBe(1);
	});

	it('lints paths on disk and takes rule levels', async () => {
		const [reply] = await talk(
			[call(1, 'lint_paths', { paths: ['src'], rules: { JEV006: 'off' } })],
			{ 'src/a.json': BAD, 'src/b.json': CLEAN },
		);
		expect(body(reply).totals).toMatchObject({ files: 2, questions: 3 });
		expect(JSON.stringify(body(reply))).not.toContain('JEV006');
	});

	it('lists every rule, and says which need Jev itself', async () => {
		const [reply] = await talk([call(1, 'list_rules', {})]);
		const rules = body(reply).rules as { code: string; runsHere: boolean }[];
		expect(rules.find((rule) => rule.code === 'JEV004')?.runsHere).toBe(true);
		expect(rules.find((rule) => rule.code === 'JEV303')?.runsHere).toBe(false);
	});

	it.each([
		[
			'an unknown tool',
			call(1, 'lint_everything', {}),
			'Unknown tool: lint_everything',
		],
		[
			'text that is not a string',
			call(1, 'lint_text', { text: 5 }),
			"'text' must be a string",
		],
		[
			'a file type it does not read',
			call(1, 'lint_text', { text: 'x', filename: 'a.md' }),
			'Not a file type',
		],
		[
			'no paths',
			call(1, 'lint_paths', { paths: [] }),
			"'paths' must be a list",
		],
		[
			'a path that is not there',
			call(1, 'lint_paths', { paths: ['gone'] }),
			'No such file or directory: gone',
		],
		[
			'a rule level it does not know',
			call(1, 'lint_text', { text: BAD, rules: { JEV004: 'loud' } }),
			"'loud' is not a level",
		],
	])('reports %s as a failed call', async (_name, message, reason) => {
		const [reply] = await talk([message]);
		expect(reply.result.isError).toBe(true);
		expect(reply.result.content[0].text).toContain(reason);
	});

	it('answers bad JSON and an unknown method with protocol errors', async () => {
		const result = await cli(
			['--mcp'],
			{},
			'not json\n{"jsonrpc":"2.0","id":3,"method":"resources/list"}',
		);
		const [parse, method] = result.out
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(parse.error.code).toBe(-32700);
		expect(method).toMatchObject({ id: 3, error: { code: -32601 } });
	});
});
