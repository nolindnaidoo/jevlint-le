import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _reset, _secrets, _state } from './__mocks__/vscode';
import { run as runCli } from './cli/run';
import { COMMANDS } from './commands';
import { JEV_COMMANDS } from './commands/jev';
import { PROBE_COMMAND } from './commands/probe';
import { CONFIG_DEFAULTS, getConfiguration } from './config/config';
import { activate } from './extension';
import { lintText } from './lint/lint';
import { LANGUAGES } from './services/linter';
import { MCP_BUNDLE, MCP_PROVIDER_ID } from './services/mcpProvider';

const manifest = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

const BARE_CHOICE = `const q = { type: 'choice', instructions: 'Which?', criteria: { a: null, b: null } };`;

type Doc = vscode.TextDocument & { text: string };

function doc(
	text: string,
	name = 'file:///a.ts',
	languageId = 'typescript',
): Doc {
	const self = {
		text,
		languageId,
		uri: vscode.Uri.parse(name),
		getText: () => self.text,
		positionAt: (offset: number) => new vscode.Position(0, offset),
		offsetAt: (position: vscode.Position) => position.character,
	};
	return self as unknown as Doc;
}

function start(...documents: Doc[]): void {
	_state.textDocuments = documents;
	_state.activeTextEditor = documents[0]
		? { document: documents[0] }
		: undefined;
	activate({
		subscriptions: [],
		secrets: _secrets,
		asAbsolutePath: (relative: string) => `/ext/${relative}`,
		extension: { packageJSON: { version: manifest.version } },
	} as unknown as vscode.ExtensionContext);
}

function diagnostics(name = 'file:///a.ts'): vscode.Diagnostic[] {
	return (_state.diagnostics.get(name) ?? []) as vscode.Diagnostic[];
}

async function run(command: string): Promise<void> {
	await _state.commands.get(command)?.();
}

beforeEach(() => {
	_reset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('configuration', () => {
	it('declares the same defaults as package.json', () => {
		const declared = manifest.contributes.configuration.properties;
		for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
			expect(declared[`jevlint-le.${key}`]?.default, key).toEqual(value);
		}
		expect(Object.keys(declared).sort()).toEqual(
			Object.keys(CONFIG_DEFAULTS)
				.map((key) => `jevlint-le.${key}`)
				.sort(),
		);
	});

	it('falls back to defaults on values of the wrong type', () => {
		_state.config = {
			rules: 'nope',
			fallbackOptions: 3,
			ignore: null,
			include: '',
			maxFileSizeBytes: -1,
		};
		const config = getConfiguration();
		expect(config.lint.rules).toEqual({});
		expect(config.lint.fallbackOptions).toEqual(
			CONFIG_DEFAULTS.fallbackOptions,
		);
		expect(config.include).toBe(CONFIG_DEFAULTS.include);
		expect(config.maxFileSizeBytes).toBe(CONFIG_DEFAULTS.maxFileSizeBytes);
	});

	it('drops rule entries that name no rule or no severity', () => {
		_state.config = { rules: { JEV004: 'off', JEV999: 'off', JEV001: 'loud' } };
		expect(getConfiguration().lint.rules).toEqual({ JEV004: 'off' });
	});

	// A command missing from the table is one nobody knows they can bind.
	it('lists every command and its id in the README, for binding to keys', () => {
		const readme = readFileSync('README.md', 'utf8');
		const section = readme.slice(
			readme.indexOf('## Keyboard shortcuts'),
			readme.indexOf('## Settings'),
		);
		const missing = manifest.contributes.commands.filter(
			(command: { command: string; title: string }) =>
				!section.includes(`\`${command.command}\``) ||
				// The title up to any note in brackets, as the palette shows it.
				!section.includes(`| ${command.title.replace(/ \(.*\)$/, '')} |`),
		);
		expect(missing).toEqual([]);
	});

	it('declares every command it registers', () => {
		start();
		const declared = manifest.contributes.commands
			.map((command: { command: string }) => command.command)
			.sort();
		expect([..._state.commands.keys()].sort()).toEqual(declared);
		expect(
			[
				...Object.values(COMMANDS),
				...Object.values(JEV_COMMANDS),
				PROBE_COMMAND,
			].sort(),
		).toEqual(declared);
	});
});

describe('diagnostics', () => {
	it('lints open documents on activation and shows the count', () => {
		start(doc(BARE_CHOICE));
		expect(diagnostics()).toHaveLength(1);
		expect(diagnostics()[0]).toMatchObject({
			source: 'jevlint-le',
			severity: vscode.DiagnosticSeverity.Information,
		});
		expect(diagnostics()[0]?.code).toMatchObject({ value: 'JEV004' });
		expect(_state.statusBar).toMatchObject({
			text: '$(checklist) Jev 1',
			visible: true,
		});
	});

	it('hides the status bar for a file with no questions', () => {
		start(doc('const a = 1;'));
		expect(_state.statusBar.visible).toBe(false);
	});

	it('shows the unread count beside the findings', () => {
		start(doc(`const q = { type: 'noul', instructions: build() };`));
		expect(_state.statusBar.text).toBe('$(checklist) Jev 1 · 1 unread');
	});

	it('leaves unsupported languages alone', () => {
		start(doc(BARE_CHOICE, 'file:///a.rb', 'ruby'));
		expect(_state.diagnostics.size).toBe(0);
	});

	it('re-lints after an edit, once the debounce passes', () => {
		const document = doc('const a = 1;');
		start(document);
		document.text = BARE_CHOICE;
		_state.listeners.change?.({ document });
		expect(diagnostics()).toHaveLength(0);
		vi.advanceTimersByTime(300);
		expect(diagnostics()).toHaveLength(1);
	});

	it('clears diagnostics when a document closes', () => {
		const document = doc(BARE_CHOICE);
		start(document);
		_state.listeners.close?.(document);
		expect(_state.diagnostics.has('file:///a.ts')).toBe(false);
	});

	it('drops stale diagnostics from a file that grew past the size limit', () => {
		const document = doc(BARE_CHOICE);
		start(document);
		_state.config = { maxFileSizeBytes: 10 };
		_state.listeners.open?.(document);
		expect(_state.diagnostics.has('file:///a.ts')).toBe(false);
		expect(_state.statusBar.visible).toBe(false);
	});

	it('re-lints when its settings change', () => {
		start(doc(BARE_CHOICE));
		_state.config = { rules: { JEV004: 'off' } };
		_state.listeners.config?.({
			affectsConfiguration: (section: string) => section === 'jevlint-le',
		});
		expect(diagnostics()).toHaveLength(0);
	});
});

describe('quick fix', () => {
	const actionsFor = (
		document: Doc,
		found: vscode.Diagnostic[],
	): vscode.CodeAction[] => {
		const provider = _state.provider as vscode.CodeActionProvider;
		return provider.provideCodeActions(
			document,
			{} as vscode.Range,
			{ diagnostics: found } as never,
			{} as never,
		) as vscode.CodeAction[];
	};

	it('fixes everything safe at once when asked by kind, as fix on save asks', () => {
		const broken = `const q = { questions: { late: { type: 'noul', instructions: 'Did it arrive late?', criteria: { yes: 'Late', no: 'On time' } }, team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', technical: 'Faults' } } } };`;
		const document = doc(broken);
		start(document);
		const provider = _state.provider as vscode.CodeActionProvider;
		const asked = (only: unknown) =>
			provider.provideCodeActions(
				document,
				{} as vscode.Range,
				{ diagnostics: [], only } as never,
				{} as never,
			) as vscode.CodeAction[];
		const [action] = asked(vscode.CodeActionKind.SourceFixAll);
		const edit = action?.edit as unknown as { edits: { text: string }[] };
		expect(edit.edits[0]?.text).toContain("{ true: 'Late', false: 'On time' }");
		// Adding an option is the author's call, so fix on save leaves it.
		expect(edit.edits[0]?.text).not.toContain('other');

		document.text = `const q = { type: 'noul', instructions: 'Is it late?' };`;
		expect(asked(vscode.CodeActionKind.SourceFixAll)).toEqual([]);
	});

	it('offers the fallback edit for the JEV004 diagnostic', () => {
		const document = doc(BARE_CHOICE);
		start(document);
		const actions = actionsFor(document, diagnostics());
		expect(actions.map((action) => action.title)).toEqual([
			"Add an 'other' option",
			'Disable JEV004 for this line',
			'Disable JEV004 for this file',
		]);
		expect(actions.map((action) => action.isPreferred)).toEqual([
			true,
			undefined,
			undefined,
		]);
		const edit = actions[0]?.edit as unknown as {
			edits: { text: string; range: vscode.Range }[];
		};
		const edits = edit.edits;
		expect(edits[0]?.text).toBe(", other: 'Fits none of the other options'");
		expect(edits[0]?.range.start.character).toBe(
			BARE_CHOICE.indexOf('b: null') + 'b: null'.length,
		);
	});

	const applied = (document: Doc, title: string) => {
		const action = actionsFor(
			document,
			diagnostics(document.uri.toString()),
		).find((candidate) => candidate.title === title);
		if (!action?.edit) throw new Error(`no action titled ${title}`);
		const { edits } = action.edit as unknown as {
			edits: { text: string; range: vscode.Range }[];
		};
		const at = edits[0]?.range.start.character ?? 0;
		return (
			document.text.slice(0, at) +
			(edits[0]?.text ?? '') +
			document.text.slice(at)
		);
	};
	const SPREAD = `const r = {\n\tquestions: {\n\t\tteam: { type: 'choice', instructions: 'Which?', criteria: { a: 'A', b: 'B' } },\n\t},\n};`;

	it('silences a finding on its line with a comment at the same indent', () => {
		const document = doc(SPREAD);
		start(document);
		const out = applied(document, 'Disable JEV004 for this line');
		expect(out).toContain(
			'\n\t\t// jevlint-le-disable-next-line JEV004\n\t\tteam: {',
		);
		expect(lintText(out).findings).toEqual([]);
	});

	it('silences a rule for the file with a comment at the top, under a shebang', () => {
		const document = doc(`#!/usr/bin/env node\n${SPREAD}`);
		start(document);
		const out = applied(document, 'Disable JEV004 for this file');
		expect(out.split('\n').slice(0, 2)).toEqual([
			'#!/usr/bin/env node',
			'// jevlint-le-disable JEV004',
		]);
		expect(lintText(out).findings).toEqual([]);
	});

	it('writes the comment the way the language does', () => {
		const python = doc(
			`q = {"questions": {"team": {"type": "choice", "instructions": "Which?", "criteria": {"a": "A", "b": "B"}}}}`,
			'file:///q.py',
			'python',
		);
		start(python);
		expect(applied(python, 'Disable JEV004 for this line')).toMatch(
			/^# jevlint-le-disable-next-line JEV004\n/,
		);
	});

	it.each([
		[
			'strict JSON, which has no comments',
			`{ "questions": { "team": { "type": "choice", "instructions": "Which?", "criteria": { "a": "A", "b": "B" } } } }`,
			'json',
		],
		[
			'JSON pasted into a string',
			`const body = '{"questions":{"team":{"type":"choice","instructions":"Which?","criteria":{"a":"A","b":"B"}}}}';`,
			'typescript',
		],
	])('offers no comment in %s', (_name, text, language) => {
		const document = doc(text, 'file:///x', language);
		start(document);
		expect(diagnostics('file:///x')).toHaveLength(1);
		expect(
			actionsFor(document, diagnostics('file:///x')).map(
				(action) => action.title,
			),
		).toEqual(["Add an 'other' option"]);
	});

	it('offers nothing for a diagnostic from another extension or a document it has not linted', () => {
		const document = doc(BARE_CHOICE);
		start(document);
		const foreign = Object.assign(
			new vscode.Diagnostic(diagnostics()[0]?.range as vscode.Range, 'm', 1),
			{ source: 'eslint' },
		);
		expect(actionsFor(document, [foreign])).toEqual([]);
		expect(
			actionsFor(doc(BARE_CHOICE, 'file:///other.ts'), diagnostics()),
		).toEqual([]);
	});
});

describe('commands', () => {
	it('reports the active file', async () => {
		start(doc(BARE_CHOICE));
		await run(COMMANDS.lintFile);
		expect(_state.messages).toEqual([
			'JevLint-LE: 1 finding in 1 Jev question.',
		]);
	});

	it('says so when no file is open or the file is not one it reads', async () => {
		start();
		await run(COMMANDS.lintFile);
		_state.activeTextEditor = {
			document: doc(BARE_CHOICE, 'file:///a.rb', 'ruby'),
		};
		await run(COMMANDS.lintFile);
		expect(_state.messages[0]).toBe('JevLint-LE: No file is open.');
		expect(_state.messages[1]).toContain('none of those');
	});

	it('lints the workspace and counts what it could not read or open', async () => {
		start();
		const good = doc(BARE_CHOICE, 'file:///good.ts');
		const hidden = doc(
			`const q = { type: 'noul', instructions: build() };`,
			'file:///hidden.ts',
		);
		const big = doc(`${BARE_CHOICE}${' '.repeat(2_000_000)}`, 'file:///big.ts');
		for (const document of [good, hidden, big])
			_state.documents.set(document.uri.toString(), document);
		_state.files = [
			good.uri,
			hidden.uri,
			big.uri,
			{ toString: () => 'file:///gone.ts' },
		];
		await run(COMMANDS.lintWorkspace);
		expect(_state.messages).toEqual([
			'JevLint-LE: 2 findings in 2 Jev questions across 2 files, 1 questions not fully read, 1 files skipped as too large, 1 files could not be opened.',
		]);
		expect(diagnostics('file:///good.ts')).toHaveLength(1);
	});

	it('refuses a second workspace run while one is going', async () => {
		start();
		const good = doc(BARE_CHOICE, 'file:///good.ts');
		_state.documents.set(good.uri.toString(), good);
		_state.files = [good.uri];
		const first = run(COMMANDS.lintWorkspace);
		await run(COMMANDS.lintWorkspace);
		expect(_state.messages).toEqual([
			'JevLint-LE: A workspace run is already going.',
		]);
		await first;
		// The first run's findings were not wiped by the second.
		expect(diagnostics('file:///good.ts')).toHaveLength(1);
		await run(COMMANDS.lintWorkspace);
		expect(_state.messages.at(-1)).not.toContain('already going');
	});

	it('says how far a workspace run got when it is stopped', async () => {
		start();
		const good = doc(BARE_CHOICE, 'file:///good.ts');
		const other = doc(BARE_CHOICE, 'file:///other.ts');
		_state.documents.set(good.uri.toString(), good);
		_state.documents.set(other.uri.toString(), other);
		_state.files = [
			{
				// The user presses cancel while the first file is being opened.
				toString: () => {
					_state.cancel?.();
					return 'file:///good.ts';
				},
			},
			other.uri,
		];
		await run(COMMANDS.lintWorkspace);
		expect(_state.messages.at(-1)).toContain('Stopped after 1 of 2 files.');
		expect(diagnostics('file:///other.ts')).toEqual([]);
	});

	it('keeps workspace findings when the editor closes a file it only read', async () => {
		start();
		const good = doc(BARE_CHOICE, 'file:///good.ts');
		_state.documents.set(good.uri.toString(), good);
		_state.files = [good.uri];
		await run(COMMANDS.lintWorkspace);
		_state.listeners.close?.(good);
		expect(diagnostics('file:///good.ts')).toHaveLength(1);
	});

	it('drops the findings of a file that is gone on the next workspace run', async () => {
		start();
		const good = doc(BARE_CHOICE, 'file:///good.ts');
		_state.documents.set(good.uri.toString(), good);
		_state.files = [good.uri];
		await run(COMMANDS.lintWorkspace);
		_state.files = [];
		await run(COMMANDS.lintWorkspace);
		expect(_state.diagnostics.size).toBe(0);
	});

	it('does not wait for a notification to be dismissed', async () => {
		start(doc(BARE_CHOICE));
		const never = new Promise<undefined>(() => {});
		const spy = vi
			.spyOn(vscode.window, 'showInformationMessage')
			.mockReturnValue(never);
		await run(COMMANDS.lintFile);
		expect(spy).toHaveBeenCalledOnce();
		spy.mockRestore();
	});

	it('opens its own settings', async () => {
		start();
		await run(COMMANDS.openSettings);
		expect(_state.executed).toEqual([
			['workbench.action.openSettings', '@ext:nolindnaidoo.jevlint-le'],
		]);
	});
});

describe('check with Jev', () => {
	const FROM_JEV = 'file:///a.ts#jevlint-le-jev';
	const VAGUE = `const r = { questions: { big: { type: 'noul', instructions: 'Is the order large?' } } };`;
	const jevSays = (answers: Record<string, { noul: number }>, status = 200) =>
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

	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.TYPESAFE_API_KEY;
	});

	it('sends nothing and says why when there is no key', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		start(doc(VAGUE));
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.messages.at(-1)).toContain('No API key');
	});

	it('keeps the key in the keychain and out of settings and messages', async () => {
		start(doc(VAGUE));
		_state.input = '  apikey_secret_value  ';
		await run(JEV_COMMANDS.setApiKey);
		expect([..._state.secrets.values()]).toEqual(['apikey_secret_value']);
		expect(JSON.stringify(_state.config)).not.toContain('apikey_secret_value');
		expect(_state.messages.join(' ')).not.toContain('apikey_secret_value');
		await run(JEV_COMMANDS.clearApiKey);
		expect(_state.secrets.size).toBe(0);
	});

	it('stores nothing when the box is dismissed or left blank', async () => {
		start(doc(VAGUE));
		_state.input = '   ';
		await run(JEV_COMMANDS.setApiKey);
		_state.input = undefined;
		await run(JEV_COMMANDS.setApiKey);
		expect(_state.secrets.size).toBe(0);
	});

	it('reports what Jev flags, on the question, with the probability', async () => {
		const fetch = jevSays({ JEV301: { noul: 0.02 }, JEV302: { noul: 0.91 } });
		vi.stubGlobal('fetch', fetch);
		start(doc(VAGUE));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).toHaveBeenCalledTimes(1);
		const found = diagnostics(FROM_JEV).filter(
			(d) => (d.code as { value: string }).value === 'JEV302',
		);
		expect(found).toHaveLength(1);
		expect(found[0]?.message).toContain('Jev put this at 0.91');
		expect(_state.messages.at(-1)).toBe(
			'JevLint-LE: Jev answered 1 request and flagged 1, 310 input tokens on jev-1.13.0.',
		);
	});

	it('underlines the option Jev points at and names the pair', async () => {
		const overlapping = `const r = { questions: { kind: { type: 'choice', instructions: 'Which?', criteria: { pet: 'An animal kept at home', dog: 'A dog', other: 'Anything else' } } } };`;
		vi.stubGlobal(
			'fetch',
			jevSays({
				JEV303: { noul: 0.9 },
				'JEV303.0': { noul: 0.8 },
				'JEV303.1': { noul: 0.5 },
				'JEV303.2': { noul: 0.1 },
			}),
		);
		start(doc(overlapping));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		const found = diagnostics(FROM_JEV)[0];
		expect(found?.message).toContain("Jev points at 'pet' and 'dog'.");
		expect(found?.range.start.character).toBe(overlapping.indexOf('pet:'));
	});

	it('says what it will send and what it will cost before sending, and stops on no', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		_state.config = { 'jev.confirm': true };
		start(doc(VAGUE));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		_state.answer = undefined;
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).not.toHaveBeenCalled();
		// One question, one line under it: how much, what it costs, what leaves the machine.
		expect(_state.modals[0]).toMatch(
			/^Send 1 request to TypeSafe\?\nAbout [\d,]+ tokens, under 1¢\. Your state is not sent\.$/,
		);
	});

	it('says so in the question when the state will be sent', async () => {
		vi.stubGlobal('fetch', jevSays({}));
		_state.config = { 'jev.sendState': true, 'jev.confirm': true };
		start(
			doc(
				`{ "state": "note", "questions": { "a": { "type": "noul", "instructions": "One?" } } }`,
				'file:///a.ts',
				'json',
			),
		);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.modals[0]).toContain('Your state is sent too.');
	});

	it('says in the question what it is leaving out', async () => {
		vi.stubGlobal('fetch', jevSays({}));
		_state.config = { 'jev.confirm': true };
		start(
			doc(
				`const r = { questions: { a: { type: 'noul', instructions: 'Is the order large?' }, b: { type: 'noul', instructions: build() } } };`,
			),
		);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.modals[0]?.split('\n')[2]).toBe(
			'Skipped: 1 built at runtime.',
		);
	});

	it('does not ask unless the user has switched the question on', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		start(doc(VAGUE));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		_state.answer = undefined;
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.modals).toEqual([]);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('uses a key typed into the settings, ahead of the keychain', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		_state.config = { 'jev.apiKey': '  typed-key  ' };
		_state.secrets.set('jevlint-le.typesafeApiKey', 'stored-key');
		start(doc(VAGUE));
		await run(JEV_COMMANDS.checkWithJev);
		const init = (
			fetch.mock.calls[0] as unknown as [
				string,
				{ headers: Record<string, string> },
			]
		)[1];
		expect(init.headers.Authorization).toBe('Bearer typed-key');
		expect(_state.messages.join(' ')).not.toContain('typed-key');
		expect(_state.modals.join(' ')).not.toContain('typed-key');
	});

	it('lets the key be set only in user settings, and keeps it out of sync', () => {
		const setting =
			manifest.contributes.configuration.properties['jevlint-le.jev.apiKey'];
		// A workspace setting lives in the repository, where a key would be committed.
		expect(setting.scope).toBe('application');
		expect(setting.ignoreSync).toBe(true);
	});

	it('takes the key from the environment when the keychain has none', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		process.env.TYPESAFE_API_KEY = 'from-env';
		start(doc(VAGUE));
		await run(JEV_COMMANDS.checkWithJev);
		const init = (
			fetch.mock.calls[0] as unknown as [
				string,
				{ headers: Record<string, string> },
			]
		)[1];
		expect(init.headers.Authorization).toBe('Bearer from-env');
	});

	it('never sends a question with a part built at runtime, and says how many it held back', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		start(
			doc(
				`const r = { questions: { a: { type: 'noul', instructions: build() } } };`,
			),
		);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.messages.at(-1)).toContain('1 built at runtime and not sent');
	});

	it('stops at jev.maxCalls and counts what it did not send', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		_state.config = { 'jev.maxCalls': 2 };
		const many = `const r = { questions: { a: { type: 'noul', instructions: 'One?' }, b: { type: 'noul', instructions: 'Two?' }, c: { type: 'noul', instructions: 'Three?' } } };`;
		start(doc(many));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).toHaveBeenCalledTimes(2);
		// The third question, and the one request about the three as a set.
		expect(_state.messages.at(-1)).toContain(
			'2 over the jev.maxCalls limit and not sent',
		);
	});

	it('stops on a rejected key after one request', async () => {
		const fetch = jevSays({}, 401);
		vi.stubGlobal('fetch', fetch);
		const two = `const r = { questions: { a: { type: 'noul', instructions: 'One?' }, b: { type: 'noul', instructions: 'Two?' } } };`;
		start(doc(two));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'wrong');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(_state.messages.at(-1)).toContain('rejected the API key');
		expect(_state.messages.join(' ')).not.toContain('wrong');
	});

	const TWO = `{ "state": { "note": "Wheel wobbles." }, "model": "jev-1.13.0", "questions": { "a": { "type": "noul", "instructions": "One?" }, "b": { "type": "noul", "instructions": "Two?" } } }`;
	const bodies = (fetch: ReturnType<typeof jevSays>) =>
		fetch.mock.calls.map((call) =>
			JSON.parse((call as unknown as [string, { body: string }])[1].body),
		);
	const jevCode = (code: string) =>
		diagnostics(FROM_JEV).find(
			(d) => (d.code as { value: string }).value === code,
		);

	it('does not send the state unless the user switched that on', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		start(doc(TWO, 'file:///a.ts', 'json'));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(JSON.stringify(bodies(fetch))).not.toContain('Wheel wobbles');
		expect(bodies(fetch)[0].state.other_questions).toEqual(['b']);
	});

	it('sends the same requests as the command line does for the same file', async () => {
		const fromEditor = jevSays({});
		vi.stubGlobal('fetch', fromEditor);
		start(doc(TWO, 'file:///a.json', 'json'));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);

		const fromCli = jevSays({});
		await runCli(['--jev', 'a.json'], {
			files: {
				stat: (path) =>
					path === 'a.json' ? { kind: 'file', size: 1 } : undefined,
				list: () => [],
				write: () => {},
				read: () => TWO,
			},
			stdin: async () => '',
			lines: async function* () {},
			out: () => {},
			err: () => {},
			version: '0',
			env: { TYPESAFE_API_KEY: 'k' },
			terminal: false,
			fetch: fromCli as never,
			wait: async () => {},
			stopSignal: () => new AbortController().signal,
		});
		expect(bodies(fromEditor).length).toBeGreaterThan(1);
		expect(bodies(fromCli)).toEqual(bodies(fromEditor));
	});

	it('sends the state, and checks it, once the user switches that on', async () => {
		const fetch = jevSays({ JEV312: { noul: 0.99 } });
		vi.stubGlobal('fetch', fetch);
		_state.config = { 'jev.sendState': true };
		start(doc(TWO, 'file:///a.ts', 'json'));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(bodies(fetch)[0].state.state).toEqual({ note: 'Wheel wobbles.' });
		expect(jevCode('JEV312')?.range.start.character).toBe(
			TWO.indexOf('"state"'),
		);
	});

	it('reports two questions that ask the same thing, on the second', async () => {
		vi.stubGlobal('fetch', jevSays({ 'JEV310.0.1': { noul: 0.8 } }));
		start(doc(TWO, 'file:///a.ts', 'json'));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(jevCode('JEV310')?.message).toContain("this question and 'a'");
		expect(jevCode('JEV310')?.range.start.character).toBe(TWO.indexOf('"b"'));
	});

	it('offers to set the key when there is none, and does it when asked', async () => {
		vi.stubGlobal('fetch', jevSays({}));
		start(doc(VAGUE));
		_state.press = 'Set API Key';
		_state.input = 'fresh-key';
		await run(JEV_COMMANDS.checkWithJev);
		await vi.waitFor(() =>
			expect(_state.executed).toContainEqual([JEV_COMMANDS.setApiKey]),
		);
		expect(_state.buttons).toEqual(['Set API Key']);
		expect(_state.messages[0]).toContain('No API key');
	});

	it('offers to open workspace trust when the workspace is untrusted', async () => {
		start(doc(VAGUE));
		_state.trusted = false;
		_state.press = 'Manage Workspace Trust';
		await run(JEV_COMMANDS.checkWithJev);
		await vi.waitFor(() =>
			expect(_state.executed).toContainEqual(['workbench.trust.manage']),
		);
	});

	it('refuses in an untrusted workspace', async () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		start(doc(VAGUE));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		_state.trusted = false;
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.messages.at(-1)).toContain('untrusted workspace');
		// The message has to say what to do about it, not only what is wrong.
		expect(_state.messages.at(-1)).toContain('Manage Workspace Trust');
	});

	it('drops what Jev said once the text changes', async () => {
		vi.stubGlobal('fetch', jevSays({ JEV302: { noul: 0.91 } }));
		const document = doc(VAGUE);
		start(document);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(diagnostics(FROM_JEV)).toHaveLength(1);
		_state.listeners.change?.({ document });
		expect(diagnostics(FROM_JEV)).toEqual([]);
	});

	it('never calls the network while linting', () => {
		const fetch = jevSays({});
		vi.stubGlobal('fetch', fetch);
		const document = doc(VAGUE);
		start(document);
		_state.listeners.open?.(document);
		_state.listeners.change?.({ document });
		vi.advanceTimersByTime(1000);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('probe a question', () => {
	const REQUEST = `{ "state": { "note": "Cracked lid, three days late." }, "model": "jev-1.13.0", "questions": { "what": { "type": "choice", "instructions": "What went wrong?", "criteria": { "late": "Arrived late", "damaged": "Arrived damaged", "other": "Something else" } } } }`;
	const cursorIn = (document: Doc, text: string) => {
		_state.activeTextEditor = {
			document,
			selection: {
				active: new vscode.Position(0, document.text.indexOf(text)),
			},
		};
	};
	const answering = (choices: string[]) => {
		const queue = [...choices];
		return vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				model: 'jev-1.13.0',
				answers: {
					q: { type: 'choice', choice: queue.shift(), confidence: 0.6 },
				},
				usage: { input_tokens: 300 },
			}),
			text: async () => '',
		}));
	};

	afterEach(() => vi.unstubAllGlobals());

	it('sends the question as written three times, then each layout change, and reports what moved', async () => {
		const fetch = answering([
			'damaged',
			'damaged',
			'damaged',
			'late',
			'option_2',
		]);
		vi.stubGlobal('fetch', fetch);
		const document = doc(REQUEST, 'file:///a.ts', 'json');
		start(document);
		cursorIn(document, 'What went wrong');
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(PROBE_COMMAND);
		expect(fetch).toHaveBeenCalledTimes(5);
		// Running the command is the decision to send, so nothing is asked by default.
		expect(_state.modals).toEqual([]);
		const report = _state.shown[0] ?? '';
		expect(report).toContain(
			'The answer changed when the question was laid out differently: options reversed.',
		);
		expect(report).toContain('| names hidden | damaged | 0.60 |  |');
	});

	it('opens the report as a rendered page that is not a file to save', async () => {
		vi.stubGlobal('fetch', answering(Array(5).fill('damaged')));
		const document = doc(REQUEST, 'file:///a.ts', 'json');
		start(document);
		cursorIn(document, 'What went wrong');
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(PROBE_COMMAND);
		const preview = _state.executed.find(
			([name]) => name === 'markdown.showPreview',
		);
		expect(String(preview?.[1])).toBe('jevlint-le-probe:Probe of what.md');
	});

	it('sends the real state, which is what a probe is for', async () => {
		const fetch = answering(Array(5).fill('damaged'));
		vi.stubGlobal('fetch', fetch);
		const document = doc(REQUEST, 'file:///a.ts', 'json');
		start(document);
		cursorIn(document, 'What went wrong');
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(PROBE_COMMAND);
		const body = JSON.parse(
			(fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body,
		);
		expect(body.state).toEqual({ note: 'Cracked lid, three days late.' });
		expect(_state.shown[0]).toContain('The answer held under every change.');
	});

	it.each([
		[
			'the cursor is outside any question',
			REQUEST,
			'"model"',
			'Put the cursor inside a Jev question',
		],
		[
			'the state is not written in the file',
			`const r = { state, questions: { what: { type: 'noul', instructions: 'Is it late?' } } };`,
			'Is it late',
			'needs a request with the state written out',
		],
		[
			'the question is built at runtime',
			`const r = { state: 's', questions: { what: { type: 'noul', instructions: build('x') } } };`,
			"build('x')",
			'built at runtime',
		],
	])('sends nothing when %s', async (_name, text, at, reason) => {
		const fetch = answering([]);
		vi.stubGlobal('fetch', fetch);
		const document = doc(text);
		start(document);
		cursorIn(document, at);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(PROBE_COMMAND);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.messages.at(-1)).toContain(reason);
	});

	it('asks first when the question is switched on, and sends nothing on no', async () => {
		const fetch = answering([]);
		vi.stubGlobal('fetch', fetch);
		_state.config = { 'jev.confirm': true };
		const document = doc(REQUEST, 'file:///a.ts', 'json');
		start(document);
		cursorIn(document, 'What went wrong');
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		_state.answer = undefined;
		await run(PROBE_COMMAND);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.modals).toEqual([
			"Probe 'what' with 5 requests to TypeSafe?\nUnder 1¢. The question and its state are sent.",
		]);
	});
});

describe('how much it says', () => {
	const VAGUE = `const r = { questions: { big: { type: 'noul', instructions: 'Is the order large?' } } };`;
	const reply = (cancel = false) =>
		vi.fn(async () => {
			if (cancel) _state.cancel?.();
			return {
				ok: true,
				status: 200,
				json: async () => ({
					model: 'jev-1.13.0',
					answers: {},
					usage: { input_tokens: 1 },
				}),
				text: async () => '',
			};
		});
	const check = async (level: string, cancel = false, key = true) => {
		vi.stubGlobal('fetch', reply(cancel));
		_state.config = { notificationsLevel: level };
		start(doc(VAGUE));
		if (key) _state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		return _state.messages;
	};

	afterEach(() => vi.unstubAllGlobals());

	it.each([
		['all', 1],
		['important', 0],
		['silent', 0],
	])(
		'at %s shows the summary of a run that worked %i time(s)',
		async (level, count) => {
			expect(await check(level)).toHaveLength(count);
		},
	);

	it.each([
		['all', 1],
		['important', 1],
		['silent', 0],
	])('at %s says a run was cancelled %i time(s)', async (level, count) => {
		const messages = await check(level, true);
		expect(
			messages.filter((message) => message.includes('Cancelled')),
		).toHaveLength(count);
	});

	it.each(['all', 'important', 'silent'])(
		'at %s always says why a command could not run',
		async (level) => {
			expect((await check(level, false, false)).at(-1)).toContain('No API key');
		},
	);

	it('still lints and shows findings when silent', async () => {
		_state.config = { notificationsLevel: 'silent' };
		start(doc(BARE_CHOICE));
		await run(COMMANDS.lintFile);
		expect(_state.messages).toEqual([]);
		expect(diagnostics()).toHaveLength(1);
	});

	it('sends every notification through the notifier, so the setting governs them all', () => {
		const direct = [
			'commands/index.ts',
			'commands/jev.ts',
			'commands/probe.ts',
			'extension.ts',
			'services/linter.ts',
			'services/reviewer.ts',
		]
			.map((file) => readFileSync(`src/${file}`, 'utf8'))
			.join('\n');
		expect(direct).not.toMatch(/show(Warning|Error)Message/);
		// A modal that waits for an answer is an interaction, and the only direct call allowed.
		const asked = direct.match(/showInformationMessage\(/g)?.length ?? 0;
		expect(asked).toBe(direct.match(/modal: true/g)?.length ?? 0);
	});

	it('hides summaries by default, and on a value it does not know', async () => {
		_state.suite = {};
		vi.stubGlobal('fetch', reply());
		start(doc(VAGUE));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.messages).toEqual([]);
		_state.config = { notificationsLevel: 'quiet' };
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.messages).toEqual([]);
	});
});

describe('the editor context menu', () => {
	const entries = manifest.contributes.menus['editor/context'] as {
		command: string;
		when: string;
	}[];

	it('offers only commands that are declared', () => {
		const declared = manifest.contributes.commands.map(
			(command: { command: string }) => command.command,
		);
		for (const entry of entries) expect(declared).toContain(entry.command);
	});

	it('shows in exactly the languages the linter reads', () => {
		for (const entry of entries) {
			const listed = /\^\((.*)\)\$/.exec(entry.when)?.[1]?.split('|');
			expect(listed?.sort()).toEqual([...LANGUAGES].sort());
		}
	});
});

describe('when the editor fails', () => {
	const TWO = `const r = { questions: { a: { type: 'noul', instructions: 'Is the order large?' }, b: { type: 'noul', instructions: 'Is the parcel heavy?' } } };`;
	const REQUEST = `{ "state": { "note": "Cracked lid." }, "model": "jev-1.13.0", "questions": { "what": { "type": "choice", "instructions": "What went wrong?", "criteria": { "late": "Arrived late", "damaged": "Arrived damaged", "other": "Something else" } } } }`;
	const reply = (answers: unknown) => ({
		ok: true,
		status: 200,
		json: async () => ({
			model: 'jev-1.13.0',
			answers,
			usage: { input_tokens: 300 },
		}),
		text: async () => '',
	});
	const probing = () => {
		const document = doc(REQUEST, 'file:///a.ts', 'json');
		start(document);
		_state.activeTextEditor = {
			document,
			selection: {
				active: new vscode.Position(0, REQUEST.indexOf('What went wrong')),
			},
		};
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
	};

	afterEach(() => vi.unstubAllGlobals());

	it('drops what Jev said when the settings it was filtered by change', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => reply({ JEV302: { noul: 0.9 } })),
		);
		start(doc(TWO));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(diagnostics('file:///a.ts#jevlint-le-jev')).not.toEqual([]);
		_state.listeners.config?.({ affectsConfiguration: () => true });
		expect(diagnostics('file:///a.ts#jevlint-le-jev')).toEqual([]);
	});

	it('shows nothing from Jev about text that was edited during the run', async () => {
		const document = doc(TWO);
		const fetch = vi.fn(async () => {
			// The user types while the first answer is on its way back.
			document.text = `// edited\n${TWO}`;
			_state.listeners.change?.({ document });
			return reply({ JEV302: { noul: 0.9 } });
		});
		vi.stubGlobal('fetch', fetch);
		start(document);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(diagnostics('file:///a.ts#jevlint-le-jev')).toEqual([]);
		// The edit also stops the run, so nothing more is paid for.
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(_state.messages.at(-1)).toContain(
			'The file changed while Jev was answering, so nothing is shown. Jev had answered 1 of 3 requests.',
		);
	});

	it('shows nothing from Jev about a file that was closed during the run', async () => {
		const document = doc(TWO);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				_state.listeners.close?.(document);
				return reply({ JEV302: { noul: 0.9 } });
			}),
		);
		start(document);
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(diagnostics('file:///a.ts#jevlint-le-jev')).toEqual([]);
	});

	it('does not start a second Jev check of a file while one is running', async () => {
		let answer: (() => void) | undefined;
		const fetch = vi.fn(
			() =>
				new Promise((resolve) => {
					answer = () => resolve(reply({}));
				}),
		);
		vi.stubGlobal('fetch', fetch);
		start(doc(TWO));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		const first = run(JEV_COMMANDS.checkWithJev);
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.messages.at(-1)).toContain('already checking this file');
		expect(fetch).toHaveBeenCalledTimes(1);
		// Let the first run finish, one answer at a time.
		for (let i = 0; i < 3; i += 1) {
			await vi.waitFor(() => expect(answer).toBeDefined());
			const settle = answer;
			answer = undefined;
			settle?.();
		}
		await first;
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('says a Jev check was cancelled, and how much of it ran', async () => {
		// The user presses cancel while the first answer is on its way back.
		const fetch = vi.fn(async () => {
			_state.cancel?.();
			return reply({ JEV302: { noul: 0.9 } });
		});
		vi.stubGlobal('fetch', fetch);
		start(doc(TWO));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(_state.messages.at(-1)).toContain('Cancelled after 1 of 3 requests');
	});

	it('does not call a cancelled request a network failure', async () => {
		const fetch = vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
			_state.cancel?.();
			init.signal.throwIfAborted();
			return reply({});
		});
		vi.stubGlobal('fetch', fetch);
		start(doc(TWO));
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(_state.messages.at(-1)).toContain('Cancelled');
		expect(_state.messages.at(-1)).not.toContain('Could not reach');
	});

	it('shows no probe report for a probe that was cancelled part way', async () => {
		const fetch = vi.fn(async () => {
			_state.cancel?.();
			return reply({
				q: { type: 'choice', choice: 'damaged', confidence: 0.6 },
			});
		});
		vi.stubGlobal('fetch', fetch);
		probing();
		await run(PROBE_COMMAND);
		expect(_state.shown).toEqual([]);
		expect(_state.messages.at(-1)).toContain(
			'Probe cancelled after 1 of 5 requests',
		);
	});

	it('still tells the user what a probe found when the report cannot be opened', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				reply({ q: { type: 'choice', choice: 'damaged', confidence: 0.6 } }),
			),
		);
		probing();
		_state.showDocumentError = new Error('no editor');
		await run(PROBE_COMMAND);
		expect(_state.messages.at(-1)).toContain(
			'The answer held under every change.',
		);
	});

	it.each([
		['checking with Jev', JEV_COMMANDS.checkWithJev],
		['clearing the key', JEV_COMMANDS.clearApiKey],
		['saving the key', JEV_COMMANDS.setApiKey],
		['probing', PROBE_COMMAND],
	])('says the keychain could not be used when %s', async (_name, command) => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		probing();
		_state.input = 'new-key';
		_state.secretsError = new Error('locked');
		await run(command);
		expect(_state.messages.at(-1)).toContain('keychain');
		expect(_state.messages.at(-1)).not.toContain('saved');
		expect(_state.messages.at(-1)).not.toContain('removed');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('falls back to the environment key when the keychain cannot be read', async () => {
		const fetch = vi.fn(async () => reply({}));
		vi.stubGlobal('fetch', fetch);
		vi.stubEnv('TYPESAFE_API_KEY', 'from-env');
		start(doc(TWO));
		_state.secretsError = new Error('locked');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).toHaveBeenCalled();
		vi.unstubAllEnvs();
	});
});

describe('the MCP server offered to agents in the editor', () => {
	it('is registered under the id the manifest declares', () => {
		start();
		const declared = manifest.contributes.mcpServerDefinitionProviders.map(
			(provider: { id: string }) => provider.id,
		);
		expect([..._state.mcpProviders.keys()]).toEqual(declared);
		expect(declared).toEqual([MCP_PROVIDER_ID]);
	});

	it('starts the shipped command line as a server, under the editor as Node', () => {
		start();
		const [definition] =
			_state.mcpProviders.get(MCP_PROVIDER_ID)?.provideMcpServerDefinitions() ??
			[];
		expect(definition).toMatchObject({
			command: process.execPath,
			args: [`/ext/${MCP_BUNDLE}`, '--mcp'],
			env: { ELECTRON_RUN_AS_NODE: '1' },
			version: manifest.version,
		});
	});

	it('ships the bundle it points at', () => {
		const ignore = readFileSync('.vscodeignore', 'utf8');
		expect(ignore).toContain(`!${MCP_BUNDLE}`);
		expect(manifest.scripts['build:prod']).toContain(`--outfile=${MCP_BUNDLE}`);
	});

	it('is skipped without complaint in an editor that has no agent mode', () => {
		const register = vscode.lm.registerMcpServerDefinitionProvider;
		Object.assign(vscode.lm, {
			registerMcpServerDefinitionProvider: undefined,
		});
		expect(() => start(doc(BARE_CHOICE))).not.toThrow();
		expect(diagnostics()).toHaveLength(1);
		expect(_state.mcpProviders.size).toBe(0);
		Object.assign(vscode.lm, { registerMcpServerDefinitionProvider: register });
	});
});

describe('a project settings file in the editor', () => {
	const NO_FALLBACK = `const r = { questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', technical: 'Faults' } } } };`;
	const within = (tree: Record<string, string>, ...documents: Doc[]) => {
		_state.textDocuments = documents;
		_state.activeTextEditor = documents[0]
			? { document: documents[0] }
			: undefined;
		activate(
			{
				subscriptions: [],
				secrets: _secrets,
				asAbsolutePath: (relative: string) => `/ext/${relative}`,
				extension: { packageJSON: { version: manifest.version } },
			} as unknown as vscode.ExtensionContext,
			{ isFile: (path) => path in tree, read: (path) => tree[path] ?? '' },
		);
	};
	const file = () => doc(NO_FALLBACK, 'file:///work/app/src/q.ts');

	it('replaces the editor settings, so the editor reports what the command line would', () => {
		_state.config = { rules: { JEV004: 'error' } };
		within(
			{ '/work/app/jevlint-le.json': '{ "rules": { "JEV004": "off" } }' },
			file(),
		);
		expect(diagnostics('file:///work/app/src/q.ts')).toEqual([]);
	});

	describe('a copy of the tool installed in the project', () => {
		const installed = (version: string) => ({
			'/work/app/node_modules/jevlint-le/package.json': `{ "version": "${version}" }`,
		});

		it("is named in the status bar when its version is not the editor's", () => {
			_state.workspaceFolder = '/work/app';
			within(installed('0.0.1'), file());
			expect(_state.statusBar.text).toBe(
				'$(checklist) Jev 1 · project has 0.0.1',
			);
			expect(_state.statusBar.tooltip).toContain(
				`This project installs jevlint-le 0.0.1. The editor is linting with its own ${manifest.version}`,
			);
		});

		it('is not mentioned when the versions are the same', () => {
			_state.workspaceFolder = '/work/app';
			within(installed(manifest.version), file());
			expect(_state.statusBar.text).toBe('$(checklist) Jev 1');
		});

		it('is not mentioned when the project has none', () => {
			within({}, file());
			expect(_state.statusBar.text).toBe('$(checklist) Jev 1');
		});
	});

	it('does not lint a file the settings file leaves out, as the command line does not', () => {
		within(
			{ '/work/app/jevlint-le.json': '{ "exclude": ["src/q.ts"] }' },
			file(),
		);
		expect(diagnostics('file:///work/app/src/q.ts')).toEqual([]);
	});

	it('leaves the editor settings in charge where there is none', () => {
		_state.config = { rules: { JEV004: 'error' } };
		within({}, file());
		expect(diagnostics('file:///work/app/src/q.ts')[0]?.severity).toBe(
			vscode.DiagnosticSeverity.Error,
		);
	});

	it('reports the same findings as the command line for the same file and settings', async () => {
		const settings =
			'{ "rules": { "JEV004": "warning" }, "fallbackOptions": ["technical"] }';
		within({ '/work/app/jevlint-le.json': settings }, file());
		const editor = diagnostics('file:///work/app/src/q.ts').map(
			(d) => `${(d.code as { value: string }).value} ${d.severity}`,
		);
		const out: string[] = [];
		await runCli(['--format', 'json', 'src/q.ts'], {
			files: {
				stat: (path) =>
					({ 'src/q.ts': NO_FALLBACK, 'jevlint-le.json': settings })[path] ===
					undefined
						? undefined
						: { kind: 'file', size: 1 },
				list: () => [],
				write: () => {},
				read: (path) =>
					({ 'src/q.ts': NO_FALLBACK, 'jevlint-le.json': settings })[path] ??
					'',
			},
			stdin: async () => '',
			lines: async function* () {},
			out: (text) => out.push(text),
			err: () => {},
			version: '0',
			env: {},
			terminal: false,
			fetch: async () => {
				throw new Error('offline');
			},
			wait: async () => {},
			stopSignal: () => new AbortController().signal,
		});
		const levels: Record<string, number> = {
			error: 0,
			warning: 1,
			info: 2,
			hint: 3,
		};
		const cli = JSON.parse(out.join('')).files[0].findings.map(
			(f: { code: string; severity: string }) =>
				`${f.code} ${levels[f.severity]}`,
		);
		expect(editor).toEqual(cli);
	});

	it('looks no higher than the workspace folder', () => {
		_state.workspaceFolder = '/work/app';
		within(
			{ '/work/jevlint-le.json': '{ "rules": { "JEV004": "off" } }' },
			file(),
		);
		expect(diagnostics('file:///work/app/src/q.ts')).toHaveLength(1);
	});

	it('is not looked for when the file is not on disk', () => {
		within(
			{ '/jevlint-le.json': '{ "rules": { "JEV004": "off" } }' },
			doc(NO_FALLBACK, 'untitled:/q.ts'),
		);
		expect(diagnostics('untitled:/q.ts')).toHaveLength(1);
	});

	it('stops linting and says why when it cannot be used', async () => {
		within({ '/work/app/jevlint-le.json': '{ "rule": {} }' }, file());
		expect(diagnostics('file:///work/app/src/q.ts')).toEqual([]);
		expect(_state.statusBar).toMatchObject({
			text: '$(warning) Jev not linted',
			tooltip: expect.stringContaining(
				"jevlint-le.json: 'rule' is not a setting",
			),
			visible: true,
		});
		await run(COMMANDS.lintFile);
		expect(_state.messages.at(-1)).toContain("'rule' is not a setting");
	});

	it('will not ask Jev about a file whose settings cannot be used', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		within({ '/work/app/jevlint-le.json': '{ "rule": {} }' }, file());
		_state.secrets.set('jevlint-le.typesafeApiKey', 'k');
		await run(JEV_COMMANDS.checkWithJev);
		expect(fetch).not.toHaveBeenCalled();
		expect(_state.messages.at(-1)).toContain("'rule' is not a setting");
		vi.unstubAllGlobals();
	});

	it('lints open files again when the file is written', () => {
		const tree: Record<string, string> = {};
		within(tree, file());
		expect(diagnostics('file:///work/app/src/q.ts')).toHaveLength(1);
		tree['/work/app/jevlint-le.json'] = '{ "rules": { "JEV004": "off" } }';
		for (const changed of _state.watchers) changed();
		expect(diagnostics('file:///work/app/src/q.ts')).toEqual([]);
	});
});
