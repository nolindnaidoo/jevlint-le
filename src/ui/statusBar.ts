import * as vscode from 'vscode';
import type { LintResult } from '../types';

/** Something about how the file was linted that its reader should know. */
export type Note = Readonly<{
	/** A few words for the status bar itself. */
	short: string;
	/** The sentence for the tooltip. */
	detail: string;
}>;

export type StatusBar = Readonly<{
	show: (result: LintResult | undefined, note?: Note) => void;
	/** Says the file was not linted, and why. */
	warn: (reason: string) => void;
	dispose: () => void;
}>;

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function summarize(result: LintResult): string {
	const base = `${plural(result.findings.length, 'finding')} in ${plural(result.questionCount, 'Jev question')}`;
	if (!result.unreadableCount) return base;
	return `${base}, ${result.unreadableCount} not fully read`;
}

export function createStatusBar(command: string): StatusBar {
	const item = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		100,
	);
	item.command = command;
	return Object.freeze({
		show: (result: LintResult | undefined, note?: Note) => {
			// A file with no Jev questions has nothing to report, so the item stays out of the way.
			if (!result?.questionCount) {
				item.hide();
				return;
			}
			const unread = result.unreadableCount
				? ` · ${result.unreadableCount} unread`
				: '';
			const noted = note ? ` · ${note.short}` : '';
			item.text = `$(checklist) Jev ${result.findings.length}${unread}${noted}`;
			item.tooltip = note
				? `${summarize(result)}\n${note.detail}`
				: summarize(result);
			item.show();
		},
		warn: (reason: string) => {
			item.text = '$(warning) Jev not linted';
			item.tooltip = reason;
			item.show();
		},
		dispose: () => item.dispose(),
	});
}
