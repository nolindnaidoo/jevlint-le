import { readFileSync, statSync } from 'node:fs';
import * as vscode from 'vscode';
import { COMMANDS, registerCommands } from './commands';
import { registerJevCommands } from './commands/jev';
import { registerProbeCommand } from './commands/probe';
import { getConfiguration, SECTION } from './config/config';
import type { ConfigFs } from './config/projectConfig';
import type { Fetch } from './jev/client';
import { createLinter, LANGUAGES } from './services/linter';
import { registerMcpProvider } from './services/mcpProvider';
import { createProjectConfigs } from './services/projectConfigs';
import { createReviewer } from './services/reviewer';
import { createCodeActionProvider } from './ui/codeActions';
import { createStatusBar } from './ui/statusBar';

const DISK: ConfigFs = Object.freeze({
	isFile: (path: string) =>
		statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
	read: (path: string) => readFileSync(path, 'utf8'),
});

/** `fs` is where settings files are read from. A test passes its own. */
export function activate(
	context: vscode.ExtensionContext,
	fs: ConfigFs = DISK,
): void {
	const statusBar = createStatusBar(COMMANDS.lintFile);
	const active = () => vscode.window.activeTextEditor?.document;

	const projectConfigs = createProjectConfigs({
		fs,
		// The settings a file is linted under have changed, so every open file is linted again.
		onChange: () => settingsChanged(),
	});
	const lintOptionsFor = (document: vscode.TextDocument) =>
		projectConfigs.for(document, getConfiguration().lint);
	const showFor = (document: vscode.TextDocument): void => {
		const problem = linter.problemFor(document);
		if (problem) {
			statusBar.warn(problem);
			return;
		}
		statusBar.show(linter.resultFor(document));
	};

	const linter = createLinter({
		getConfiguration,
		lintOptionsFor,
		onResult: (document) => {
			if (document === active()) showFor(document);
		},
	});

	// The only code in this extension that reaches the network, and only when
	// the user runs the command. Linting never calls anything.
	const network = {
		fetch: ((url, init) => fetch(url, init)) as Fetch,
		wait: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
	};
	const reviewer = createReviewer({ getConfiguration, ...network });

	const showActive = (): void => {
		const document = active();
		if (document) {
			showFor(document);
			return;
		}
		statusBar.show(undefined);
	};

	const lintOpen = (): void => {
		for (const document of vscode.workspace.textDocuments)
			linter.lint(document);
	};

	// What Jev said was filtered by the old rule levels, so it goes too. A check
	// still running is stopped: it was planned under settings that no longer hold.
	const settingsChanged = (): void => {
		for (const document of vscode.workspace.textDocuments)
			reviewer.clear(document);
		lintOpen();
	};

	const mcp = registerMcpProvider(context);
	if (mcp) context.subscriptions.push(mcp);

	context.subscriptions.push(
		linter,
		reviewer,
		statusBar,
		projectConfigs,
		...registerCommands({ linter, getConfiguration }),
		...registerJevCommands({
			reviewer,
			getConfiguration,
			lintOptionsFor,
			secrets: context.secrets,
			env: process.env,
		}),
		...registerProbeCommand({
			getConfiguration,
			secrets: context.secrets,
			env: process.env,
			...network,
		}),
		vscode.languages.registerCodeActionsProvider(
			LANGUAGES.map((language) => ({ language })),
			createCodeActionProvider({ resultFor: linter.resultFor }),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
		vscode.workspace.onDidOpenTextDocument((document) => linter.lint(document)),
		vscode.workspace.onDidChangeTextDocument((event) => {
			linter.schedule(event.document);
			// What Jev said was about text that has now changed. Showing it would be a claim nobody checked.
			reviewer.clear(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			linter.forget(document);
			reviewer.clear(document);
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(SECTION)) settingsChanged();
		}),
		vscode.window.onDidChangeActiveTextEditor(showActive),
	);

	lintOpen();
	showActive();
}

export function deactivate(): void {}
