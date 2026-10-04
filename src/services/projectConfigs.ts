import { basename } from 'node:path';
import * as vscode from 'vscode';
import {
	CONFIG_FILE,
	type ConfigFs,
	createConfigLoader,
} from '../config/projectConfig';
import type { LintOptions } from '../types';

/** The lint settings for a document, or why its settings file could not be used. */
export type Resolved =
	| Readonly<{ options: LintOptions }>
	| Readonly<{ problem: string }>;

export type ProjectConfigs = Readonly<{
	/**
	 * The settings that apply to a document. A `jevlint-le.json` in its folder
	 * or one above it, no higher than the workspace folder, replaces the editor's own
	 * settings, so the editor reports what the command line would.
	 */
	for: (document: vscode.TextDocument, settings: LintOptions) => Resolved;
	dispose: () => void;
}>;

type Deps = Readonly<{
	fs: ConfigFs;
	/** Called when a settings file is written, added or removed. */
	onChange: () => void;
}>;

export function createProjectConfigs(deps: Deps): ProjectConfigs {
	const loader = createConfigLoader(deps.fs);
	const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE}`);
	const changed = (): void => {
		loader.clear();
		deps.onChange();
	};
	const subscriptions = [
		watcher.onDidChange(changed),
		watcher.onDidCreate(changed),
		watcher.onDidDelete(changed),
	];

	return Object.freeze({
		for: (document: vscode.TextDocument, settings: LintOptions): Resolved => {
			// A file that is not on disk has no folder to look in.
			if (document.uri.scheme !== 'file') return { options: settings };
			const file = document.uri.fsPath;
			const folder = vscode.workspace.getWorkspaceFolder(document.uri);
			// A file opened on its own has no folder to stop at, so the search runs to the top.
			const found = loader.for(file, folder?.uri.fsPath);
			if (!found) return { options: settings };
			if (typeof found.options === 'string')
				return { problem: `${basename(found.path)}: ${found.options}` };
			return { options: found.options };
		},
		dispose: () => {
			for (const subscription of subscriptions) subscription.dispose();
			watcher.dispose();
		},
	});
}
