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

// The key is taken out of the environment, so no run here can reach TypeSafe.
const { TYPESAFE_API_KEY: _key, ...env } = process.env;

function cli(args, input) {
	const result = spawnSync(process.execPath, [bin, ...args], {
		cwd: join(root, 'samples'),
		input,
		encoding: 'utf8',
		env,
	});
	return { status: result.status, out: result.stdout, err: result.stderr };
}

const codes = (out) => [...out.matchAll(/ {2}(JEV\d{3}) {2}/g)].map((m) => m[1]);

const version = cli(['--version']);
assert.strictEqual(version.out.trim(), require(join(root, 'package.json')).version);

// The samples hold planted mistakes, the same ones the editor tests expect.
const python = cli(['--format', 'compact', 'triage.py']);
assert.strictEqual(python.status, 1, python.err);
assert.deepStrictEqual(codes(python.out), [
	'JEV004', 'JEV008', 'JEV000', 'JEV009', 'JEV006', 'JEV005', 'JEV001',
]);

for (const name of ['triage.rs', 'triage.go']) {
	const typed = cli(['--format', 'compact', name]);
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
	['--format', 'compact', '--stdin-filename', 'q.json'],
	'{ "model": "jev-latest", "questions": { "a": { "type": "noul", "instructions": "Is it late?" } } }',
);
assert.deepStrictEqual(codes(piped.out), ['JEV001']);
assert.strictEqual(piped.status, 0);

const wrong = cli(['--fromat', 'json']);
assert.strictEqual(wrong.status, 2);
assert.match(wrong.err, /Unknown option '--fromat'/);
assert.strictEqual(wrong.out, '');

// A reader that closes the pipe early, as `head` does, must not crash the tool.
// The report has to be larger than a pipe holds for the write to fail at all.
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const big = join(mkdtempSync(join(tmpdir(), 'jevlint-le-')), 'big.json');
const question = (i) => `"q${i}": {"type":"choice","instructions":"Which team is it?","criteria":{"a":"A","b":"B"}}`;
writeFileSync(big, `{"questions": {${Array.from({ length: 3000 }, (_, i) => question(i)).join(',')}}}`);
const closedEarly = spawnSync(
	process.execPath,
	['-e', `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, [${JSON.stringify(bin)}, '--format', 'json', ${JSON.stringify(big)}], { stdio: ['ignore', 'pipe', 'pipe'] });
		let err = '';
		child.stderr.on('data', (chunk) => { err += chunk; });
		child.stdout.once('data', () => child.stdout.destroy());
		child.on('close', () => { process.stdout.write(err); });
	`],
	{ encoding: 'utf8' },
);
assert.strictEqual(closedEarly.stdout, '', 'crashed when its reader closed the pipe');

// The Jev checks, as far as they go with nothing sent: the plan, and the refusal without a key.
const plan = cli(['--jev-plan', '--format', 'json', 'clean.ts']);
assert.strictEqual(plan.status, 0, plan.err);
const planned = JSON.parse(plan.out).totals.jev;
assert.strictEqual(planned.sent, false);
assert.ok(planned.planned > 0, 'planned no requests for a file with questions');
assert.strictEqual(planned.answered, 0);

const keyless = cli(['--jev', 'clean.ts']);
assert.strictEqual(keyless.status, 2);
assert.match(keyless.err, /--jev needs an API key in TYPESAFE_API_KEY/);
assert.strictEqual(keyless.out, '');

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
assert.deepStrictEqual(replies[1].result.tools.map((tool) => tool.name), ['lint_text', 'lint_paths', 'fix_text', 'list_rules', 'explain_rule']);
assert.ok(replies[1].result.tools.every((tool) => tool.annotations.readOnlyHint && tool.outputSchema));
const linted = JSON.parse(replies[2].result.content[0].text);
assert.strictEqual(linted.files[0].findings.length, 7);
// The answer as data is the text, so a client may read either.
assert.deepStrictEqual(replies[2].result.structuredContent, linted);
// The rule pages ship in the bundle: an agent with no network still gets an example.
const explained = cli(['--mcp'], `${JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'explain_rule', arguments: { code: 'JEV006' } } })}\n`);
assert.strictEqual(explained.status, 0, explained.err);
const page = JSON.parse(explained.out.trim()).result;
assert.strictEqual(page.isError, false);
assert.match(page.content[0].text, /^# JEV006 criteria-shape\n/);
assert.match(page.content[0].text, /## Flagged\n/);
assert.strictEqual(page.structuredContent.markdown, page.content[0].text);

// The library the editor loads from a project's node_modules, required the way
// the editor requires it: by the file the manifest names.
const npmManifest = require(join(root, 'npm', 'package.json'));
const library = require(join(root, 'npm', npmManifest.main));
assert.strictEqual(library.api, 1);
assert.deepStrictEqual([...library.syntaxes].sort(), ['go', 'js', 'python', 'rust']);
assert.ok(library.rules.JEV004.docs.startsWith('https://'));
assert.ok(library.rules.JEV004.page.endsWith('/docs/rules/JEV004.md'));
const BROKEN_NOUL = '{ "questions": { "late": { "type": "noul", "instructions": "Did it arrive late?", "criteria": { "yes": "Late", "no": "On time" } } } }';
const libraryOptions = { rules: {}, fallbackOptions: ['other'], ignore: [] };
assert.deepStrictEqual(
	library.lint(BROKEN_NOUL, libraryOptions, 'js').findings.map((finding) => finding.code),
	['JEV006', 'JEV006'],
);
assert.strictEqual(library.fix(BROKEN_NOUL, libraryOptions, 'js').fixed, 2);
// Requiring it must not start the command line or touch the process.
assert.strictEqual(process.exitCode, undefined);

// What would be uploaded: the bundles, the manifest, the readme and the license, and nothing else.
const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(root, 'npm'), encoding: 'utf8' });
assert.strictEqual(packed.status, 0, packed.stderr);
const [tarball] = JSON.parse(packed.stdout);
assert.deepStrictEqual(tarball.files.map((file) => file.path).sort(), ['LICENSE', 'README.md', 'cli.js', 'lib.js', 'package.json']);
assert.strictEqual(tarball.version, require(join(root, 'package.json')).version);
// One homepage on every listing. A link to a page that does not exist yet shipped once.
assert.strictEqual(
	require(join(root, 'npm', 'package.json')).homepage,
	require(join(root, 'package.json')).homepage,
);

// The server-only package: the same server as `--mcp`, reached with no flag,
// and the same answers, from the same working directory.
const server = join(root, 'mcp', 'server.js');
const spoken = spawnSync(process.execPath, [server], {
	cwd: join(root, 'samples'),
	input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
	encoding: 'utf8',
	env,
});
assert.strictEqual(spoken.status, 0, spoken.stderr);
const answers = spoken.stdout.trim().split('\n').map((line) => JSON.parse(line));
assert.strictEqual(answers[0].result.serverInfo.version, require(join(root, 'package.json')).version);
assert.deepStrictEqual(answers[1].result.tools, replies[1].result.tools);
assert.deepStrictEqual(JSON.parse(answers[2].result.content[0].text), linted);

// The registry verifies ownership by the mcpName inside the package its
// listing points at, so that package carries it and the other does not.
const mcpManifest = require(join(root, 'mcp', 'package.json'));
const listing = require(join(root, 'server.json'));
assert.strictEqual(mcpManifest.name, 'jevlint-le-mcp');
assert.strictEqual(mcpManifest.mcpName, listing.name);
assert.strictEqual(npmManifest.mcpName, undefined);
assert.strictEqual(listing.packages[0].identifier, mcpManifest.name);
assert.strictEqual(listing.packages[0].packageArguments, undefined);
assert.strictEqual(mcpManifest.homepage, require(join(root, 'package.json')).homepage);

const packedMcp = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: join(root, 'mcp'), encoding: 'utf8' });
assert.strictEqual(packedMcp.status, 0, packedMcp.stderr);
const [serverTarball] = JSON.parse(packedMcp.stdout);
assert.deepStrictEqual(serverTarball.files.map((file) => file.path).sort(), ['LICENSE', 'README.md', 'package.json', 'server.js']);
assert.strictEqual(serverTarball.version, require(join(root, 'package.json')).version);

console.log('COMMAND-LINE TEST: PASS');
