#!/usr/bin/env node
/**
 * Runs the built command-line tool as a user would: a real process, the real
 * filesystem, real exit codes. The unit tests drive `run` with a fake disk,
 * so this is the only check of the bundle, its shebang and its argument and
 * stream handling. It also checks what `npm publish` would upload.
 */
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const root = join(__dirname, '..');
const bin = join(root, 'npm', 'cli.js');

function cli(args, input) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd: join(root, 'samples'),
		input,
		encoding: 'utf8',
	});
	return { status: result.status, out: result.stdout, err: result.stderr };
}

const codes = (out) => [...out.matchAll(/ {2}(JEV\d{3}) {2}/g)].map((m) => m[1]);

const version = cli(['--version']);
assert.strictEqual(version.out.trim(), require(join(root, 'package.json')).version);

// The samples hold planted mistakes, the same ones the editor tests expect.
const python = cli(['triage.py']);
assert.strictEqual(python.status, 1, python.err);
assert.deepStrictEqual(codes(python.out), [
	'JEV004', 'JEV008', 'JEV000', 'JEV009', 'JEV006', 'JEV005', 'JEV001',
]);

for (const name of ['triage.rs', 'triage.go']) {
	const typed = cli([name]);
	assert.strictEqual(typed.status, 1, typed.err);
	assert.deepStrictEqual(codes(typed.out), [
		'JEV001', 'JEV004', 'JEV008', 'JEV000', 'JEV006', 'JEV009',
	]);
}

const clean = cli(['clean.ts']);
assert.strictEqual(clean.status, 0, clean.out);
assert.match(clean.out, /^0 findings/);

// A directory run reads every sample and none of the installed packages.
const all = cli(['.', '--format', 'json']);
const report = JSON.parse(all.out);
const paths = report.files.map((file) => file.path);
assert.ok(paths.includes('triage.jev.json') && paths.includes('triage.py'));
assert.ok(!paths.some((path) => path.includes('node_modules')), 'read node_modules');

const piped = cli(
	['--stdin-filename', 'q.json'],
	'{ "model": "jev-latest", "questions": { "a": { "type": "noul", "instructions": "Is it late?" } } }',
);
assert.deepStrictEqual(codes(piped.out), ['JEV001']);
assert.strictEqual(piped.status, 0);

const wrong = cli(['--fromat', 'json']);
assert.strictEqual(wrong.status, 2);
assert.match(wrong.err, /Unknown option '--fromat'/);
assert.strictEqual(wrong.out, '');

// The MCP server, spoken to over standard input the way an agent's client does.
const requests = [
	{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
	{ jsonrpc: '2.0', method: 'notifications/initialized' },
	{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'lint_paths', arguments: { paths: ['triage.py'] } } },
];
const served = cli(['--mcp'], `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`);
assert.strictEqual(served.status, 0, served.err);
const replies = served.out.trim().split('\n').map((line) => JSON.parse(line));
assert.deepStrictEqual(replies.map((reply) => reply.id), [1, 2, 3]);
assert.strictEqual(replies[0].result.serverInfo.version, require(join(root, 'package.json')).version);
assert.deepStrictEqual(replies[1].result.tools.map((tool) => tool.name), ['lint_text', 'lint_paths', 'list_rules']);
const linted = JSON.parse(replies[2].result.content[0].text);
assert.strictEqual(linted.files[0].findings.length, 7);

// What would be uploaded: the bundle, its manifest, the readme and the license, and nothing else.
const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(root, 'npm'), encoding: 'utf8' });
assert.strictEqual(packed.status, 0, packed.stderr);
const [tarball] = JSON.parse(packed.stdout);
assert.deepStrictEqual(tarball.files.map((file) => file.path).sort(), ['LICENSE', 'README.md', 'cli.js', 'package.json']);
assert.strictEqual(tarball.version, require(join(root, 'package.json')).version);
// One homepage on every listing. A link to a page that does not exist yet shipped once.
assert.strictEqual(
	require(join(root, 'npm', 'package.json')).homepage,
	require(join(root, 'package.json')).homepage,
);

console.log('COMMAND-LINE TEST: PASS');
