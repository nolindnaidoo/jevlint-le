import * as vscode from 'vscode';
import { findInstalled, type Installed } from '../config/installed';
import { type ConfigFs, parent } from '../config/projectConfig';

// Asked on every lint, so the answer for a folder is kept this long. A
// project's packages change with an install, not with a keystroke.
const KEPT_MS = 10_000;

/** The copy of this tool a document's project has installed, if it has one. */
export type InstalledLookup = (
	document: vscode.TextDocument,
) => Installed | undefined;

export function createInstalledLookup(fs: ConfigFs): InstalledLookup {
	const known = new Map<string, { at: number; found: Installed | undefined }>();
	return (document) => {
		// A file that is not on disk has no project around it.
		if (document.uri.scheme !== 'file') return undefined;
		const file = document.uri.fsPath;
		const dir = parent(file);
		const kept = known.get(dir);
		if (kept && Date.now() - kept.at < KEPT_MS) return kept.found;
		const folder = vscode.workspace.getWorkspaceFolder(document.uri);
		const found = findInstalled(file, folder?.uri.fsPath, fs);
		known.set(dir, { at: Date.now(), found });
		return found;
	};
}
