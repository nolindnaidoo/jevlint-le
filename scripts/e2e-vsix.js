#!/usr/bin/env node
/**
 * Installed-VSIX end-to-end test: installs release/<name>-<version>.vsix
 * into a CLEAN VS Code profile (fresh extensions + user-data dirs), opens
 * samples/ as the workspace and drives the installed extension. This is the
 * exact artifact users get, not the dev folder, so it is the only test that
 * can catch a file left out by .vscodeignore.
 *
 * Usage: bun run package && node scripts/e2e-vsix.js
 *
 * The profile dirs must be SHORT paths. macOS caps the user-data-dir socket
 * path (~103 chars), and deep temp dirs fail with a cryptic `claimInstance`
 * error at startup.
 *
 * The temp profile is left in the OS temp directory for the OS to reclaim.
 * Nothing here deletes a directory tree.
 */
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} = require('@vscode/test-electron');

const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const vsixPath = path.resolve(
	'release',
	`${manifest.name}-${manifest.version}.vsix`,
);
const samplesDir = path.resolve('samples');

if (!fs.existsSync(vsixPath)) {
	console.error(`FAIL: ${vsixPath} not found. Run \`bun run package\` first.`);
	process.exit(1);
}

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-e2e-'));
const extensionsDir = path.join(profileRoot, 'ext');
const userDataDir = path.join(profileRoot, 'usr');

// Probe extension: a no-op dev extension whose test suite exercises the
// INSTALLED extension under test.
const probeDir = path.join(profileRoot, 'probe');
fs.mkdirSync(probeDir, { recursive: true });
fs.writeFileSync(
	path.join(probeDir, 'package.json'),
	JSON.stringify({
		name: 'vsix-e2e-probe',
		publisher: 'local',
		version: '0.0.1',
		engines: { vscode: manifest.engines.vscode },
		main: './extension.js',
	}),
);
fs.writeFileSync(
	path.join(probeDir, 'extension.js'),
	'module.exports = { activate() {}, deactivate() {} };\n',
);
fs.writeFileSync(
	path.join(probeDir, 'suite.js'),
	`const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const codes = (uri) =>
	vscode.languages
		.getDiagnostics(uri)
		.filter((d) => d.source === 'jevlint-le')
		.sort((a, b) => a.range.start.compareTo(b.range.start))
		.map((d) => String(d.code.value));

async function until(check, describe) {
	const deadline = Date.now() + 10000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail('timed out: ' + describe());
}

exports.run = async function run() {
	const ext = vscode.extensions.getExtension(${JSON.stringify(extensionId)});
	assert.ok(ext, 'installed ${extensionId} not found');
	assert.ok(
		!ext.extensionPath.startsWith(${JSON.stringify(path.resolve('.'))}),
		'the dev folder was loaded instead of the installed VSIX',
	);

	// Every file the manifest points at must have survived packaging.
	const contributes = ext.packageJSON.contributes;
	const shipped = [
		ext.packageJSON.main,
		ext.packageJSON.icon,
		...contributes.jsonValidation.map((v) => v.url),
		...contributes.snippets.map((s) => s.path),
	];
	for (const file of shipped)
		assert.ok(
			fs.existsSync(path.join(ext.extensionPath, file) + (path.extname(file) ? '' : '.js')),
			file + ' is missing from the installed VSIX. Check .vscodeignore',
		);

	// Opening a JSON file must activate the extension on its own. Nothing here calls activate().
	const folder = vscode.workspace.workspaceFolders[0].uri;
	const json = vscode.Uri.joinPath(folder, 'triage.jev.json');
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(json));
	const expectedJson = ['JEV001', 'JEV004', 'JEV008', 'JEV006', 'JEV006', 'JEV007', 'JEV006', 'JEV005'];
	await until(
		() => JSON.stringify(codes(json)) === JSON.stringify(expectedJson),
		() => 'triage.jev.json has ' + JSON.stringify(codes(json)),
	);
	assert.strictEqual(ext.isActive, true, 'opening a JSON file did not activate the extension');

	// The contributed schema must be the one applied to *.jev.json. The linter
	// owns question validation, so the schema is proved by something only it
	// reports: a request body with no state. Checked while the file is the
	// visible editor, because the JSON service only reports on documents that
	// are showing.
	const bare = vscode.Uri.joinPath(folder, 'missing-state.jev.json');
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(bare));
	await until(
		() => vscode.languages.getDiagnostics(bare).some((d) => d.source !== 'jevlint-le' && /state/.test(d.message)),
		() => 'the request schema did not flag the missing state; got ' +
			JSON.stringify(vscode.languages.getDiagnostics(bare).map((d) => d.message)),
	);
	assert.deepStrictEqual(codes(bare), []);

	// The MCP server, as it ships: the bundle must be in the VSIX, the manifest
	// must declare the provider, and the bundle must start the way the
	// extension starts it. process.execPath here is the editor's own binary, as
	// it is in the extension host, so this fails if ELECTRON_RUN_AS_NODE stops working.
	const cp = require('child_process');
	const server = path.join(ext.extensionPath, 'dist', 'cli.js');
	assert.ok(fs.existsSync(server), 'dist/cli.js is missing from the installed VSIX. Check .vscodeignore');
	assert.deepStrictEqual(
		(contributes.mcpServerDefinitionProviders || []).map((p) => p.id),
		['jevlint-le'],
	);
	const asked = [
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
	].map((m) => JSON.stringify(m)).join('\\n') + '\\n';
	const answered = cp.spawnSync(process.execPath, [server, '--mcp'], {
		env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
		input: asked,
		encoding: 'utf8',
		timeout: 20000,
	});
	assert.strictEqual(answered.status, 0, 'the shipped MCP server failed: ' + answered.stderr);
	const replies = answered.stdout.trim().split('\\n').map((line) => JSON.parse(line));
	assert.strictEqual(replies[0].result.serverInfo.version, ext.packageJSON.version);
	assert.deepStrictEqual(replies[1].result.tools.map((t) => t.name), ['lint_text', 'lint_paths', 'fix_text', 'list_rules', 'explain_rule', 'plan_jev', 'check_with_jev', 'probe_question']);

	const ts = vscode.Uri.joinPath(folder, 'triage.ts');
	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ts));
	const expectedTs = ['JEV001', 'JEV004', 'JEV008', 'JEV000', 'JEV009', 'JEV007', 'JEV005'];
	await until(
		() => JSON.stringify(codes(ts)) === JSON.stringify(expectedTs),
		() => 'triage.ts has ' + JSON.stringify(codes(ts)),
	);

	const registered = await vscode.commands.getCommands(true);
	for (const command of contributes.commands)
		assert.ok(registered.includes(command.command), 'missing command: ' + command.command);

	console.log('VSIX E2E OK:', JSON.stringify({ json: codes(json), ts: codes(ts) }));
};
`,
);

(async () => {
	const vscodeExecutablePath = await downloadAndUnzipVSCode('stable');
	const [cli, ...args] =
		resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

	cp.execFileSync(
		cli,
		[
			...args,
			'--extensions-dir',
			extensionsDir,
			'--user-data-dir',
			userDataDir,
			'--install-extension',
			vsixPath,
		],
		{ stdio: 'inherit' },
	);

	await runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: probeDir,
		extensionTestsPath: path.join(probeDir, 'suite.js'),
		launchArgs: [
			samplesDir,
			'--extensions-dir',
			extensionsDir,
			'--user-data-dir',
			userDataDir,
		],
	});
	console.log(`INSTALLED-VSIX TEST: PASS (${path.basename(vsixPath)})`);
})().catch((error) => {
	console.error('INSTALLED-VSIX TEST: FAIL', error);
	process.exitCode = 1;
});
