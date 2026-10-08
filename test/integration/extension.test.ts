import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'nolindnaidoo.jevlint-le';

// What each sample is written to trigger, in document order. The samples are
// the fixture: change one and this table together.
const EXPECTED: Readonly<Record<string, ReadonlyArray<string>>> = {
	'triage.jev.json': [
		'JEV001',
		'JEV004',
		'JEV008',
		'JEV006',
		'JEV006',
		'JEV007',
		'JEV006',
		'JEV005',
	],
	'triage.ts': [
		'JEV001',
		'JEV004',
		'JEV008',
		'JEV000',
		'JEV009',
		'JEV007',
		'JEV005',
	],
	'triage.py': [
		'JEV004',
		'JEV008',
		'JEV000',
		'JEV009',
		'JEV006',
		'JEV005',
		'JEV001',
	],
	'triage.rs': [
		'JEV001',
		'JEV004',
		'JEV008',
		'JEV000',
		'JEV006',
		'JEV009',
	],
	'triage.go': [
		'JEV001',
		'JEV004',
		'JEV008',
		'JEV000',
		'JEV006',
		'JEV009',
	],
	'clean.ts': [],
	'missing-state.jev.json': [],
	'wording.jev.json': [
		'JEV101',
		'JEV102',
		'JEV105',
		'JEV110',
		'JEV103',
		'JEV112',
	],
	'.oxlintrc.json': ['JEV001', 'JEV005', 'JEV007'],
};

function sample(name: string): vscode.Uri {
	const folder = vscode.workspace.workspaceFolders?.[0];
	assert.ok(folder, 'the samples folder is not open as the workspace');
	return vscode.Uri.joinPath(folder.uri, name);
}

// The editor cancels a code-action request when the document changes under
// it, which a test that has just opened or edited a file can race. That is the
// editor declining to answer, not an answer, so the request is made again.
async function quickFixes(
	uri: vscode.Uri,
	range: vscode.Range,
): Promise<vscode.CodeAction[]> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await vscode.commands.executeCommand<vscode.CodeAction[]>(
				'vscode.executeCodeActionProvider',
				uri,
				range,
				vscode.CodeActionKind.QuickFix.value,
			);
		} catch (error) {
			const cancelled = error instanceof Error && error.message === 'Canceled';
			if (!cancelled || attempt === 5) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

function ours(uri: vscode.Uri): vscode.Diagnostic[] {
	return vscode.languages
		.getDiagnostics(uri)
		.filter((diagnostic) => diagnostic.source === 'jevlint-le')
		.sort((a, b) => a.range.start.compareTo(b.range.start));
}

function codeOf(diagnostic: vscode.Diagnostic): string {
	const code = diagnostic.code;
	return typeof code === 'object' ? String(code.value) : String(code);
}

function codes(uri: vscode.Uri): string[] {
	return ours(uri).map(codeOf);
}

async function until(
	check: () => boolean,
	describe: () => string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`timed out: ${describe()}`);
}

async function untilCodes(
	uri: vscode.Uri,
	expected: ReadonlyArray<string>,
): Promise<void> {
	await until(
		() => JSON.stringify(codes(uri)) === JSON.stringify(expected),
		() =>
			`${uri.path} has ${JSON.stringify(codes(uri))}, expected ${JSON.stringify(expected)}`,
	);
}

async function open(name: string): Promise<vscode.TextEditor> {
	const document = await vscode.workspace.openTextDocument(sample(name));
	return vscode.window.showTextDocument(document);
}

async function closeAll(): Promise<void> {
	// Revert first: these tests edit the samples in memory and must never save them.
	await vscode.commands.executeCommand('workbench.action.files.revert');
	await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

describe('JevLint-LE in a real editor', function () {
	this.timeout(60_000);

	before(async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `extension ${EXTENSION_ID} not found`);
		await extension.activate();
		assert.strictEqual(extension.isActive, true);
	});

	afterEach(closeAll);

	it('registers every declared command', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		const declared: string[] = extension?.packageJSON.contributes.commands.map(
			(command: { command: string }) => command.command,
		);
		const registered = await vscode.commands.getCommands(true);
		assert.strictEqual(declared.length, 7);
		for (const id of declared)
			assert.ok(registered.includes(id), `missing command: ${id}`);
	});

	it('lints the whole workspace without opening a file, and skips node_modules', async () => {
		await vscode.commands.executeCommand('jevlint-le.lintWorkspace');
		for (const [name, expected] of Object.entries(EXPECTED))
			await untilCodes(sample(name), expected);
		const stray = vscode.languages
			.getDiagnostics()
			.filter(([uri, list]) =>
				list.some(
					(diagnostic) =>
						diagnostic.source === 'jevlint-le' &&
						uri.path.includes('node_modules'),
				),
			);
		assert.deepStrictEqual(stray, []);
	});

	for (const [name, expected] of Object.entries(EXPECTED)) {
		it(`reports the planted findings in ${name} when it is opened`, async () => {
			await open(name);
			await untilCodes(sample(name), expected);
		});
	}

	it('maps severities and links each finding to its own page', async () => {
		await open('triage.ts');
		await untilCodes(sample('triage.ts'), EXPECTED['triage.ts'] ?? []);
		const bySeverity = Object.fromEntries(
			ours(sample('triage.ts')).map((diagnostic) => [
				codeOf(diagnostic),
				diagnostic.severity,
			]),
		);
		assert.strictEqual(bySeverity.JEV000, vscode.DiagnosticSeverity.Hint);
		assert.strictEqual(
			bySeverity.JEV004,
			vscode.DiagnosticSeverity.Information,
		);
		assert.strictEqual(bySeverity.JEV001, vscode.DiagnosticSeverity.Warning);
		assert.strictEqual(bySeverity.JEV007, vscode.DiagnosticSeverity.Error);
		for (const diagnostic of ours(sample('triage.ts'))) {
			const code = diagnostic.code;
			assert.ok(typeof code === 'object' && code.target, 'no docs link');
			assert.strictEqual(code.target.authority, 'github.com');
			assert.ok(
				code.target.path.endsWith(`/docs/rules/${code.value}.md`),
				code.target.path,
			);
		}
	});

	it('underlines the thing each finding is about', async () => {
		const editor = await open('triage.jev.json');
		const uri = sample('triage.jev.json');
		await untilCodes(uri, EXPECTED['triage.jev.json'] ?? []);
		const texts = ours(uri).map(
			(diagnostic) =>
				`${codeOf(diagnostic)} ${editor.document.getText(diagnostic.range)}`,
		);
		assert.deepStrictEqual(texts, [
			'JEV001 "jev-latest"',
			'JEV004 "job_type"',
			'JEV008 ["0", "1", "2"]',
			'JEV006 "yes"',
			'JEV006 "no"',
			'JEV007 "nuol"',
			'JEV006 "criteria"',
			'JEV005 "job_type"',
		]);
	});

	it('applies the fallback quick fix and leaves valid JSON', async () => {
		const editor = await open('triage.jev.json');
		const uri = sample('triage.jev.json');
		await untilCodes(uri, EXPECTED['triage.jev.json'] ?? []);
		const target = ours(uri).find(
			(diagnostic) => codeOf(diagnostic) === 'JEV004',
		);
		assert.ok(target);

		const actions = await quickFixes(uri, target.range);
		const fix = actions.find(
			(action) => action.title === "Add an 'other' option",
		);
		assert.ok(
			fix?.edit,
			`no fallback fix among: ${actions.map((a) => a.title)}`,
		);
		assert.strictEqual(await vscode.workspace.applyEdit(fix.edit), true);

		await until(
			() => !codes(uri).includes('JEV004'),
			() => `JEV004 still reported: ${JSON.stringify(codes(uri))}`,
		);
		const text = editor.document.getText();
		assert.ok(
			text.includes(
				'        "gears": "Indexing, cables, or a new cassette",\n        "other": "Fits none of the other options"\n      }',
			),
			'the option was not inserted with the surrounding indentation',
		);
	});

	it('silences a finding with the disable-line quick fix', async () => {
		await open('triage.ts');
		const uri = sample('triage.ts');
		await untilCodes(uri, EXPECTED['triage.ts'] ?? []);
		const target = ours(uri).find(
			(diagnostic) => codeOf(diagnostic) === 'JEV008',
		);
		assert.ok(target);
		const actions = await quickFixes(uri, target.range);
		const silence = actions.find(
			(action) => action.title === 'Disable JEV008 for this line',
		);
		assert.ok(
			silence?.edit,
			`no disable action among: ${actions.map((a) => a.title)}`,
		);
		assert.strictEqual(await vscode.workspace.applyEdit(silence.edit), true);
		await until(
			() => !codes(uri).includes('JEV008'),
			() => `JEV008 still reported: ${JSON.stringify(codes(uri))}`,
		);
	});

	it('re-lints after an edit', async () => {
		const editor = await open('clean.ts');
		const uri = sample('clean.ts');
		await untilCodes(uri, []);
		const at = editor.document.getText().indexOf("'jev-1.13.0'");
		const range = new vscode.Range(
			editor.document.positionAt(at),
			editor.document.positionAt(at + "'jev-1.13.0'".length),
		);
		assert.strictEqual(
			await editor.edit((builder) => builder.replace(range, "'jev-latest'")),
			true,
		);
		await untilCodes(uri, ['JEV001']);
	});

	it('honours a rule switched off in settings', async () => {
		const settings = vscode.workspace.getConfiguration('jevlint-le');
		await open('triage.ts');
		await untilCodes(sample('triage.ts'), EXPECTED['triage.ts'] ?? []);
		await settings.update(
			'rules',
			{ JEV004: 'off', JEV000: 'off' },
			vscode.ConfigurationTarget.Global,
		);
		try {
			// With JEV004 off, the comment in the sample that silences a JEV004
			// silences nothing, and is reported where that finding would have been.
			await untilCodes(sample('triage.ts'), [
				'JEV001',
				'JEV008',
				'JEV010',
				'JEV009',
				'JEV007',
				'JEV005',
			]);
		} finally {
			await settings.update(
				'rules',
				undefined,
				vscode.ConfigurationTarget.Global,
			);
		}
	});

	it('runs a wording rule that is off by default once it is switched on', async () => {
		const settings = vscode.workspace.getConfiguration('jevlint-le');
		const uri = sample('wording.jev.json');
		await open('wording.jev.json');
		await untilCodes(uri, EXPECTED['wording.jev.json'] ?? []);
		await settings.update(
			'rules',
			{ JEV104: 'warning' },
			vscode.ConfigurationTarget.Global,
		);
		try {
			await untilCodes(uri, [...(EXPECTED['wording.jev.json'] ?? []), 'JEV104']);
		} finally {
			await settings.update(
				'rules',
				undefined,
				vscode.ConfigurationTarget.Global,
			);
		}
	});

	it("lints with the copy of the tool the project installs, in place of the extension's own", async () => {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		const dir = path.join(folder, 'node_modules', 'jevlint-le');
		const manifest = path.join(dir, 'package.json');
		const library = path.join(dir, 'lib.js');
		// A copy that reports one finding no real version has, so its work cannot
		// be mistaken for the extension's own.
		const copy = `module.exports = {
			api: 1,
			syntaxes: ['js'],
			rules: {},
			lint: () => ({
				findings: [{ code: 'JEV777', message: 'From the installed copy.', span: { start: 0, end: 1 }, questionId: undefined, fix: undefined, severity: 'warning' }],
				questionCount: 1,
				unreadableCount: 0,
			}),
			fix: (text) => ({ text, fixed: 0 }),
		};`;
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(manifest, '{ "name": "jevlint-le", "version": "9.9.9", "main": "lib.js" }');
		fs.writeFileSync(library, copy);
		try {
			const editor = await open('clean.ts');
			const uri = sample('clean.ts');
			// The extension keeps what it knows of a folder's packages for a few
			// seconds, so the file is nudged until the new copy is noticed.
			const deadline = Date.now() + 40_000;
			while (Date.now() < deadline && codes(uri).join() !== 'JEV777') {
				await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), ' '));
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
			assert.deepStrictEqual(codes(uri), ['JEV777']);
			assert.strictEqual(ours(uri)[0]?.message, 'From the installed copy.');
		} finally {
			fs.unlinkSync(library);
			fs.unlinkSync(manifest);
			fs.rmdirSync(dir);
		}
	});

	it('leaves the samples on disk untouched', async () => {
		const bytes = await vscode.workspace.fs.readFile(sample('triage.jev.json'));
		assert.ok(
			!Buffer.from(bytes).toString('utf8').includes('"model": "jev-1'),
			'unexpected content',
		);
		assert.strictEqual(
			vscode.workspace.textDocuments.filter((document) => document.isDirty)
				.length,
			0,
		);
	});
});
