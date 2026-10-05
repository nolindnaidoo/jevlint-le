import * as vscode from 'vscode';
import type { Configuration } from '../config/config';
import type { Linter } from '../services/linter';
import { blocked, caution, result } from '../ui/notifier';
import { summarize } from '../ui/statusBar';

type Deps = Readonly<{
	linter: Linter;
	getConfiguration: () => Configuration;
}>;

export const COMMANDS = Object.freeze({
	lintFile: 'jevlint-le.lintFile',
	lintWorkspace: 'jevlint-le.lintWorkspace',
	openSettings: 'jevlint-le.openSettings',
});

const SKIP_REASONS = Object.freeze({
	language:
		'JevLint-LE reads JSON, JavaScript, TypeScript, Python, Rust and Go files. This file is none of those.',
	size: 'This file is larger than `jevlint-le.maxFileSizeBytes` and was not linted.',
});

type Tally = {
	files: number;
	findings: number;
	questions: number;
	unreadable: number;
	tooLarge: number;
	failed: number;
	/** Files whose settings file could not be used, with the first reason given. */
	misconfigured: number;
	problem: string;
};

async function lintFile(deps: Deps): Promise<void> {
	const document = vscode.window.activeTextEditor?.document;
	if (!document) {
		blocked('No file is open.');
		return;
	}
	const outcome = deps.linter.lint(document);
	if (outcome.kind === 'skipped') {
		blocked(
			'detail' in outcome ? outcome.detail : SKIP_REASONS[outcome.reason],
		);
		return;
	}
	result(`${summarize(outcome.result)}.`);
}

async function lintOne(
	deps: Deps,
	uri: vscode.Uri,
	tally: Tally,
): Promise<void> {
	const document = await vscode.workspace.openTextDocument(uri);
	const outcome = deps.linter.lint(document, { keep: true });
	if (outcome.kind === 'skipped' && outcome.reason === 'config') {
		tally.misconfigured += 1;
		tally.problem ||= outcome.detail;
		return;
	}
	if (outcome.kind === 'skipped') {
		tally.tooLarge += outcome.reason === 'size' ? 1 : 0;
		tally.failed += outcome.reason === 'error' ? 1 : 0;
		return;
	}
	tally.files += 1;
	tally.findings += outcome.result.findings.length;
	tally.questions += outcome.result.questionCount;
	tally.unreadable += outcome.result.unreadableCount;
}

function describe(tally: Tally): string {
	const parts = [
		`${tally.findings} findings in ${tally.questions} Jev questions across ${tally.files} files`,
	];
	if (tally.unreadable)
		parts.push(`${tally.unreadable} questions not fully read`);
	if (tally.tooLarge)
		parts.push(`${tally.tooLarge} files skipped as too large`);
	if (tally.failed) parts.push(`${tally.failed} files could not be opened`);
	if (tally.misconfigured)
		parts.push(
			`${tally.misconfigured} files not linted because of their settings file (${tally.problem})`,
		);
	return `${parts.join(', ')}.`;
}

// One run at a time: a second would wipe the findings the first is still adding to.
let workspaceRun = false;

async function lintWorkspace(deps: Deps): Promise<void> {
	if (workspaceRun) {
		blocked('A workspace run is already going.');
		return;
	}
	workspaceRun = true;
	try {
		await lintEveryFile(deps);
	} finally {
		workspaceRun = false;
	}
}

async function lintEveryFile(deps: Deps): Promise<void> {
	const config = deps.getConfiguration();
	const uris = await vscode.workspace.findFiles(config.include, config.exclude);
	deps.linter.reset();
	const tally: Tally = {
		files: 0,
		findings: 0,
		questions: 0,
		unreadable: 0,
		tooLarge: 0,
		failed: 0,
		misconfigured: 0,
		problem: '',
	};
	let seen = 0;
	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'JevLint-LE: linting the workspace',
			cancellable: true,
		},
		async (progress, token) => {
			let stopped = false;
			token.onCancellationRequested(() => {
				stopped = true;
			});
			for (const uri of uris) {
				if (stopped) return;
				// One unopenable file, such as a binary with a .json name, must not end the
				// run. It is counted and reported, because a silent skip reads as "clean".
				await lintOne(deps, uri, tally).catch(() => {
					tally.failed += 1;
				});
				seen += 1;
				progress.report({ message: `${seen} of ${uris.length} files` });
			}
		},
	);
	const message = describe(tally);
	// A run the user stopped must not read as one that covered the workspace.
	if (seen < uris.length) {
		caution(`Stopped after ${seen} of ${uris.length} files. ${message}`);
		return;
	}
	// Files were left out, which a reader of the findings needs to know.
	if (tally.failed || tally.tooLarge || tally.misconfigured) {
		caution(message);
		return;
	}
	result(message);
}

async function openSettings(): Promise<void> {
	await vscode.commands.executeCommand(
		'workbench.action.openSettings',
		'@ext:nolindnaidoo.jevlint-le',
	);
}

export function registerCommands(deps: Deps): ReadonlyArray<vscode.Disposable> {
	return [
		vscode.commands.registerCommand(COMMANDS.lintFile, () => lintFile(deps)),
		vscode.commands.registerCommand(COMMANDS.lintWorkspace, () =>
			lintWorkspace(deps),
		),
		vscode.commands.registerCommand(COMMANDS.openSettings, openSettings),
	];
}
