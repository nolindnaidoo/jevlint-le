import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Fetch } from '../jev/client';
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

type World = Readonly<{
	/** Changes the fake disk, to make part of it fail. */
	files?: (disk: Files) => Files;
	env?: Record<string, string>;
	fetch?: Fetch;
	signal?: AbortSignal;
}>;

const offline = () =>
	vi.fn(async () => {
		throw new Error('offline');
	}) as unknown as Fetch;

async function cli(
	args: string[],
	tree: Record<string, string> = {},
	stdin = '',
	world: World = {},
) {
	const out: string[] = [];
	const err: string[] = [];
	const io: Io = {
		files: (world.files ?? ((files) => files))(disk(tree)),
		stdin: async () => stdin,
		lines: async function* () {
			yield* stdin.split('\n');
		},
		out: (text) => out.push(text),
		err: (text) => err.push(text),
		version: '9.9.9',
		env: world.env ?? {},
		fetch: world.fetch ?? offline(),
		wait: async () => {},
		stopSignal: () => world.signal ?? new AbortController().signal,
	};
	const status = await run(args, io);
	return { status, out: out.join(''), err: err.join('') };
}

describe('arguments', () => {
	it('lists every flag in the help', () => {
		const help = helpText();
		for (const name of FLAG_NAMES)
			expect(help).toMatch(new RegExp(`[ ,] ${name}[ \\n<]`));
	});

	// A flag added to the table and left out of a readme is one nobody finds.
	it.each(['README.md', 'npm/README.md'])('are all listed in %s', (readme) => {
		const text = readFileSync(readme, 'utf8');
		const documented = FLAG_NAMES.filter(
			(name) => name !== '--help' && name !== '--version',
		);
		expect(documented.filter((name) => !text.includes(`| \`${name}`))).toEqual(
			[],
		);
	});

	it.each([
		[['-h'], 'Usage: jevlint-le'],
		[['-v'], '9.9.9'],
	])('takes %j as an option, not as a file', async (args, said) => {
		const result = await cli(args);
		expect(result.status).toBe(EXIT.passed);
		expect(result.out).toContain(said);
	});

	it('takes -f and -c for --format and --config', () => {
		const parsed = parseArgs(['-f', 'json', '-c=team.json', 'src']);
		expect(parsed.ok && parsed.options).toMatchObject({
			format: 'json',
			config: 'team.json',
			paths: ['src'],
		});
	});

	it('refuses a dash option it does not know, where it used to look for a file', async () => {
		const result = await cli(['-x']);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain("Unknown option '-x'");
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

	it('exits 2 when there is nothing to lint, unless told that is fine', async () => {
		const strict = await cli(['.'], { 'notes.md': 'x' });
		expect(strict.status).toBe(EXIT.unusable);
		const allowed = await cli(['--no-error-on-unmatched-pattern', '.'], {
			'notes.md': 'x',
		});
		expect(allowed.status).toBe(EXIT.passed);
		expect(allowed.out).toContain('across 0 files.');
	});

	it('holds standard input to the size limit files are held to', async () => {
		const result = await cli(
			['--stdin-filename', 'q.json'],
			{},
			`${CLEAN}${' '.repeat(2_000_000)}`,
		);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain('Standard input is over the size limit');
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

	it('takes a rule by its name, and warn for warning', async () => {
		const byName = await cli(
			['--rule', 'no-fallback-option=warn', '--format', 'json', 'q.json'],
			{ 'q.json': BAD },
		);
		const levels = JSON.parse(byName.out).files[0].findings.filter(
			(finding: { code: string }) => finding.code === 'JEV004',
		);
		expect(
			levels.map((finding: { severity: string }) => finding.severity),
		).toEqual(['warning']);
		const inFile = await cli(['q.json'], {
			'q.json': BAD,
			'jevlint-le.json': '{ "rules": { "no-fallback-option": "off" } }',
		});
		expect(inFile.out).not.toContain('JEV004');
		const wrong = await cli(['--rule', 'no-such-rule=off', 'q.json'], {
			'q.json': BAD,
		});
		expect(wrong.err).toContain(
			"'no-such-rule' is not a rule code or a rule name",
		);
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

describe('a disk that fails', () => {
	const denied = (path: string) => () => {
		throw new Error(`EACCES: permission denied, '${path}'`);
	};
	const tree = { 'src/q.json': CLEAN, 'locked/q.json': BAD };

	it('lints the rest when a folder cannot be listed, and names the folder', async () => {
		const result = await cli(['.'], tree, '', {
			files: (files) => ({
				...files,
				list: (path) => (path === 'locked' ? denied(path)() : files.list(path)),
			}),
		});
		expect(result.status).toBe(EXIT.passed);
		expect(result.out).toContain('in 1 question across 1 file.');
		expect(result.out).toContain('1 path could not be read: locked.');
	});

	it('lints the rest when a file cannot be read, and names the file', async () => {
		const result = await cli(['--format', 'json', '.'], tree, '', {
			files: (files) => ({
				...files,
				read: (path) =>
					path === 'locked/q.json' ? denied(path)() : files.read(path),
			}),
		});
		expect(result.status).toBe(EXIT.passed);
		expect(JSON.parse(result.out).totals.unread).toEqual(['locked/q.json']);
	});

	it('does not pass a run in which nothing could be read', async () => {
		const result = await cli(['.'], tree, '', {
			files: (files) => ({ ...files, read: (path) => denied(path)() }),
		});
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain('No files could be read.');
	});

	it('refuses a settings file it cannot read, and names it', async () => {
		const result = await cli(
			['--config', 'team.json', 'src/q.json'],
			{ ...tree, 'team.json': '{}' },
			'',
			{
				files: (files) => ({
					...files,
					read: (path) =>
						path === 'team.json' ? denied(path)() : files.read(path),
				}),
			},
		);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain('team.json: it could not be read.');
	});

	it('does not follow a linked folder, which can lead back to its parent', async () => {
		const listed: string[] = [];
		const result = await cli(
			['.'],
			{ 'src/q.json': CLEAN, 'up/q.json': BAD },
			'',
			{
				files: (files) => ({
					...files,
					stat: (path) => {
						const entry = files.stat(path);
						return entry && path === 'up' ? { ...entry, link: true } : entry;
					},
					list: (path) => {
						listed.push(path);
						return files.list(path);
					},
				}),
			},
		);
		expect(listed).not.toContain('up');
		expect(result.status).toBe(EXIT.passed);
	});

	it('still reads a linked folder that is named outright', async () => {
		const result = await cli(['up'], { 'up/q.json': BAD }, '', {
			files: (files) => ({
				...files,
				stat: (path) => {
					const entry = files.stat(path);
					return entry && path === 'up' ? { ...entry, link: true } : entry;
				},
			}),
		});
		expect(result.status).toBe(EXIT.failed);
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

	it('answers JSON that is not a request, and goes on serving', async () => {
		const result = await cli(
			['--mcp'],
			{},
			[
				'null',
				'[]',
				'7',
				JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
			].join('\n'),
		);
		const replies = result.out
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(replies.map((reply) => reply.error?.code)).toEqual([
			-32600,
			-32600,
			-32600,
			undefined,
		]);
		expect(replies[3]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
		expect(result.status).toBe(EXIT.passed);
	});

	it('fails the call when a tool throws, and goes on serving', async () => {
		const input = [
			call(1, 'lint_paths', { paths: ['gone'] }),
			{ jsonrpc: '2.0', id: 2, method: 'ping' },
		]
			.map((message) => JSON.stringify(message))
			.join('\n');
		const result = await cli(['--mcp'], {}, input, {
			files: (files) => ({
				...files,
				stat: () => {
					throw new Error('EIO: the disk went away');
				},
			}),
		});
		const [failed, pinged] = result.out
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		expect(failed.result.isError).toBe(true);
		expect(failed.result.content[0].text).toContain('the disk went away');
		expect(pinged.result).toEqual({});
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

describe('checking with Jev', () => {
	const VAGUE = `const r = { questions: { big: { type: 'noul', instructions: 'Is the order large?' } } };`;
	const HEAVY = `const r = { questions: { heavy: { type: 'noul', instructions: 'Is the parcel heavy?' } } };`;
	const RUNTIME = `const r = { questions: { a: { type: 'noul', instructions: build() } } };`;
	const STATED = `{ "state": { "note": "Wheel wobbles." }, "model": "jev-1.13.0", "questions": { "a": { "type": "noul", "instructions": "One?" }, "b": { "type": "noul", "instructions": "Two?" } } }`;
	const KEY = { TYPESAFE_API_KEY: 'apikey_secret_value' };

	const jevSays = (
		answers: Record<string, { noul: number }> = {},
		status = 200,
	) =>
		vi.fn(async () => ({
			ok: status === 200,
			status,
			json: async () => ({
				model: 'jev-1.13.0',
				answers,
				usage: { input_tokens: 310 },
			}),
			text: async () => '',
		}));
	type Sent = ReturnType<typeof jevSays>;
	const world = (fetch: Sent, env: Record<string, string> = KEY) => ({
		env,
		fetch: fetch as unknown as Fetch,
	});
	const calls = (fetch: Sent) =>
		fetch.mock.calls.map((call) => {
			const [, init] = call as unknown as [
				string,
				{ body: string; headers: Record<string, string> },
			];
			return { body: JSON.parse(init.body), headers: init.headers };
		});

	it('never uses the network or the key unless --jev is given', async () => {
		const fetch = jevSays();
		const result = await cli(['q.ts'], { 'q.ts': VAGUE }, '', world(fetch));
		expect(fetch).not.toHaveBeenCalled();
		expect(result.status).toBe(EXIT.passed);
	});

	it('prints the same report as before when --jev is not given', async () => {
		const result = await cli(['--format', 'json', 'q.ts'], { 'q.ts': VAGUE });
		expect(Object.keys(JSON.parse(result.out).totals)).toEqual([
			'files',
			'questions',
			'unreadable',
			'skipped',
			'unread',
			'counts',
		]);
	});

	it('says what it would send under --jev-plan, with no key and nothing sent', async () => {
		const fetch = jevSays();
		const result = await cli(
			['--jev-plan', '--format', 'json', '.'],
			{ 'a.ts': VAGUE, 'b.ts': RUNTIME },
			'',
			world(fetch, {}),
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(result.status).toBe(EXIT.passed);
		expect(JSON.parse(result.out).totals.jev).toMatchObject({
			sent: false,
			planned: 1,
			answered: 0,
			runtime: 1,
			overLimit: 0,
			model: 'jev-1.13.0',
			state: false,
		});
		const text = await cli(['--jev-plan', '.'], { 'a.ts': VAGUE });
		expect(text.out).toMatch(
			/--jev would send 1 request to jev-1\.13\.0, about \d+ input tokens\./,
		);
	});

	it('refuses --jev with no key, before sending anything', async () => {
		const fetch = jevSays();
		const result = await cli(
			['--jev', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(fetch, { TYPESAFE_API_KEY: '  ' }),
		);
		expect(result.status).toBe(EXIT.unusable);
		expect(fetch).not.toHaveBeenCalled();
		expect(result.err).toContain('--jev needs an API key in TYPESAFE_API_KEY');
		expect(result.out).toBe('');
	});

	it('reports what Jev flags, in its place, and says what was sent', async () => {
		const fetch = jevSays({ JEV301: { noul: 0.02 }, JEV302: { noul: 0.91 } });
		const result = await cli(
			['--jev', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(fetch),
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(EXIT.passed);
		expect(result.out).toContain(
			`q.ts:1:${VAGUE.indexOf('big') + 1}  info  JEV302  `,
		);
		expect(result.out).toContain('(Jev put this at 0.91.)');
		expect(result.out).toContain(
			'Jev answered 1 of 1 request on jev-1.13.0, 310 input tokens.',
		);
		expect(result.err).toMatch(
			/^jevlint-le: Sending 1 request to TypeSafe on jev-1\.13\.0, about \d+ input tokens\. State is not sent\.\n$/,
		);
	});

	it('sends the key as a header and prints it nowhere', async () => {
		const fetch = jevSays({ JEV302: { noul: 0.91 } });
		const text = await cli(
			['--jev', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(fetch),
		);
		const json = await cli(
			['--jev', '--format', 'json', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(jevSays({}, 401)),
		);
		expect(calls(fetch)[0]?.headers.Authorization).toBe(
			'Bearer apikey_secret_value',
		);
		for (const printed of [text.out, text.err, json.out, json.err])
			expect(printed).not.toContain('apikey_secret_value');
	});

	it('sends exactly the requests the plan counted', async () => {
		const tree = { 'a.ts': VAGUE, 'b.ts': HEAVY, 'c.json': STATED };
		const plan = await cli(['--jev-plan', '--format', 'json', '.'], tree);
		const fetch = jevSays();
		await cli(['--jev', '.'], tree, '', world(fetch));
		expect(fetch).toHaveBeenCalledTimes(
			JSON.parse(plan.out).totals.jev.planned,
		);
	});

	it('never sends a question with a part built at runtime, and counts it', async () => {
		const fetch = jevSays();
		const result = await cli(
			['--jev', 'q.ts'],
			{ 'q.ts': RUNTIME },
			'',
			world(fetch),
		);
		expect(fetch).not.toHaveBeenCalled();
		expect(result.out).toContain('Not sent: 1 question built at runtime.');
		expect(result.err).toBe('');
	});

	it('sends state only with --jev-send-state', async () => {
		const without = jevSays();
		await cli(['--jev', 'r.json'], { 'r.json': STATED }, '', world(without));
		expect(JSON.stringify(calls(without))).not.toContain('Wheel wobbles.');

		const sent = jevSays();
		const result = await cli(
			['--jev', '--jev-send-state', 'r.json'],
			{ 'r.json': STATED },
			'',
			world(sent),
		);
		expect(JSON.stringify(calls(sent))).toContain('Wheel wobbles.');
		expect(result.err).toContain('State is sent.');
	});

	it('holds the limit across files, and fails the run that passed it', async () => {
		const fetch = jevSays();
		const result = await cli(
			['--jev', '--jev-max-calls', '1', '.'],
			{ 'a.ts': VAGUE, 'b.ts': HEAVY },
			'',
			world(fetch),
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(
			'1 request over the --jev-max-calls limit not sent.',
		);
		expect(result.out).toContain('Jev answered 1 of 1 request');
	});

	it.each([
		[401, 'TypeSafe rejected the API key (401)'],
		[422, 'TypeSafe rejected the request (422)'],
		[429, 'TypeSafe is busy or the rate limit was reached (429)'],
	])('fails the run on a %i, and says how far it got', async (status, said) => {
		const result = await cli(
			['--jev', '.'],
			{ 'a.ts': VAGUE, 'b.ts': HEAVY },
			'',
			world(jevSays({}, status)),
		);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(`${said}. Jev answered 0 of 2 requests.`);
		// What linting found is still printed.
		expect(result.out).toContain('Jev answered 0 of 2 requests');
	});

	it('stops sending after a failure', async () => {
		const fetch = jevSays({}, 401);
		await cli(
			['--jev', '.'],
			{ 'a.ts': VAGUE, 'b.ts': HEAVY },
			'',
			world(fetch),
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('says it could not reach TypeSafe when the network fails', async () => {
		const result = await cli(['--jev', 'q.ts'], { 'q.ts': VAGUE }, '', {
			env: KEY,
		});
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain('Could not reach TypeSafe (offline).');
	});

	it('does not call a stopped run finished, or a network failure', async () => {
		const stop = new AbortController();
		const fetch = vi.fn(async () => {
			stop.abort();
			return {
				ok: true,
				status: 200,
				json: async () => ({
					model: 'jev-1.13.0',
					answers: {},
					usage: { input_tokens: 310 },
				}),
				text: async () => '',
			};
		});
		const result = await cli(
			['--jev', '.'],
			{ 'a.ts': VAGUE, 'b.ts': HEAVY },
			'',
			{ env: KEY, fetch: fetch as unknown as Fetch, signal: stop.signal },
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain('Stopped. Jev answered 1 of 2 requests.');
		expect(result.err).not.toContain('Could not reach');
	});

	it('cannot be switched on from a settings file', async () => {
		const fetch = jevSays();
		const result = await cli(
			['q.ts'],
			{ 'q.ts': VAGUE, 'jevlint-le.json': '{ "jev": true }' },
			'',
			world(fetch),
		);
		expect(result.status).toBe(EXIT.unusable);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('takes rule levels: off is not asked, error fails the run', async () => {
		const off = jevSays();
		await cli(
			['--jev', '--rule', 'JEV302=off', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(off),
		);
		expect(Object.keys(calls(off)[0]?.body.questions)).not.toContain('JEV302');

		const raised = await cli(
			['--jev', '--rule', 'JEV302=error', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(jevSays({ JEV302: { noul: 0.91 } })),
		);
		expect(raised.status).toBe(EXIT.failed);
	});

	it('asks the model it is given', async () => {
		const fetch = jevSays();
		await cli(
			['--jev', '--jev-model', 'jev-1.14.0', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(fetch),
		);
		expect(calls(fetch)[0]?.body.model).toBe('jev-1.14.0');
	});

	it('checks text from standard input', async () => {
		const fetch = jevSays({ JEV302: { noul: 0.91 } });
		const result = await cli(
			['--jev', '--stdin-filename', 'q.ts'],
			{},
			VAGUE,
			world(fetch),
		);
		expect(result.out).toContain('JEV302');
	});

	it('hides Jev findings under --quiet unless one is an error', async () => {
		const answers = { JEV302: { noul: 0.91 } };
		const quiet = await cli(
			['--jev', '--quiet', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(jevSays(answers)),
		);
		expect(quiet.out).not.toContain('JEV302');
		const raised = await cli(
			['--jev', '--quiet', '--rule', 'JEV302=error', 'q.ts'],
			{ 'q.ts': VAGUE },
			'',
			world(jevSays(answers)),
		);
		expect(raised.out).toContain('JEV302');
	});

	it.each([
		[['--jev-model', 'jev-1.14.0', 'q.ts'], '--jev-model needs --jev'],
		[['--jev-max-calls', '3', 'q.ts'], '--jev-max-calls needs --jev'],
		[['--jev-send-state', 'q.ts'], '--jev-send-state needs --jev'],
		[['--jev', '--mcp'], '--jev cannot be combined with --mcp'],
		[
			['--jev', '--jev-max-calls', '0', 'q.ts'],
			'not a whole number above zero',
		],
	])('refuses %j', async (args, said) => {
		const fetch = jevSays();
		const result = await cli(args, { 'q.ts': VAGUE }, '', world(fetch));
		expect(result.status).toBe(EXIT.unusable);
		expect(result.err).toContain(said);
		expect(fetch).not.toHaveBeenCalled();
	});
});
