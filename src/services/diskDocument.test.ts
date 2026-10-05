import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { EXTENSIONS } from '../lint/lint';
import { diskDocument, LANGUAGE_BY_EXTENSION } from './diskDocument';
import { LANGUAGES } from './linter';

describe('a file read from disk', () => {
	it('has an editor language for every file type the tool reads, and no other', () => {
		expect(Object.keys(LANGUAGE_BY_EXTENSION).sort()).toEqual(
			Object.keys(EXTENSIONS).sort(),
		);
		for (const id of Object.values(LANGUAGE_BY_EXTENSION))
			expect(LANGUAGES, id).toContain(id);
	});

	it('takes its language from its extension, whatever the case', () => {
		const at = (path: string) =>
			diskDocument(vscode.Uri.parse(`file://${path}`), '').languageId;
		expect(at('/work/a.py')).toBe('python');
		expect(at('/work/A.TSX')).toBe('typescriptreact');
		expect(at('/work/notes.md')).toBe('plaintext');
	});

	it('places an offset on its line and column', () => {
		const document = diskDocument(
			vscode.Uri.parse('file:///work/a.json'),
			'ab\ncd\r\nef',
		);
		const at = (offset: number) => {
			const position = document.positionAt(offset);
			return [position.line, position.character];
		};
		expect(at(0)).toEqual([0, 0]);
		expect(at(2)).toEqual([0, 2]);
		expect(at(3)).toEqual([1, 0]);
		expect(at(7)).toEqual([2, 0]);
		expect(at(9)).toEqual([2, 2]);
	});
});
