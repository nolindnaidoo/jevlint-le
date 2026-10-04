import * as vscode from 'vscode';
import { getConfiguration } from '../config/config';

/**
 * Every message the extension shows goes through here, so that
 * `notificationsLevel` governs all of them. They are sorted by what the user
 * loses if one is hidden, not by the icon it carries.
 *
 * None of these is awaited. A notification's promise settles when the toast
 * closes, which can be never, and awaiting it would hold the command open.
 */

const NAME = 'JevLint-LE';

function show(
	send: (message: string) => Thenable<unknown>,
	message: string,
): void {
	// A rejection means the window went away. There is nobody left to tell.
	void send(`${NAME}: ${message}`).then(undefined, () => {});
}

/** What a command did: a summary of a run that worked. Shown only at `all`. */
export function result(message: string): void {
	if (getConfiguration().notificationsLevel !== 'all') return;
	show(vscode.window.showInformationMessage, message);
}

/** A run that finished short of what was asked, such as one the user cancelled. Hidden at `silent`. */
export function caution(message: string): void {
	if (getConfiguration().notificationsLevel === 'silent') return;
	show(vscode.window.showWarningMessage, message);
}

/**
 * Why a command the user just ran did nothing. Always shown: with this
 * hidden, the command would appear to be broken.
 */
export function blocked(message: string): void {
	show(vscode.window.showWarningMessage, message);
}

/** `blocked`, with one button that does what the message asks for. */
export function offer(message: string, button: string, command: string): void {
	void vscode.window.showWarningMessage(`${NAME}: ${message}`, button).then(
		(chosen) =>
			chosen === button ? vscode.commands.executeCommand(command) : undefined,
		() => {},
	);
}
