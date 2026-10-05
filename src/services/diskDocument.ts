import * as vscode from 'vscode';

/**
 * The editor's language for each file type the tool reads. The editor decides
 * this itself for a file it opens. A file read from disk was never opened, so
 * it is decided here. `diskDocument.test.ts` holds this to `EXTENSIONS`.
 */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> =
	Object.freeze({
		json: 'json',
		jsonc: 'jsonc',
		js: 'javascript',
		jsx: 'javascriptreact',
		mjs: 'javascript',
		cjs: 'javascript',
		ts: 'typescript',
		tsx: 'typescriptreact',
		mts: 'typescript',
		cts: 'typescript',
		py: 'python',
		rs: 'rust',
		go: 'go',
	});

function lineStarts(text: string): ReadonlyArray<number> {
	const starts = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1))
		starts.push(i + 1);
	return starts;
}

/**
 * A file's text as the linter needs a document to be: where it is, what
 * language it is, its text, and where an offset falls. Opening a real
 * document for every file in a workspace run holds each one in the editor's
 * memory for minutes. This holds nothing once the file is linted.
 */
export function diskDocument(
	uri: vscode.Uri,
	text: string,
): vscode.TextDocument {
	const path = uri.path;
	const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
	const starts = lineStarts(text);
	const positionAt = (offset: number): vscode.Position => {
		const after = starts.findIndex((start) => start > offset);
		const line = after === -1 ? starts.length - 1 : after - 1;
		return new vscode.Position(line, offset - (starts[line] ?? 0));
	};
	return {
		uri,
		languageId: LANGUAGE_BY_EXTENSION[extension] ?? 'plaintext',
		getText: () => text,
		positionAt,
	} as unknown as vscode.TextDocument;
}
