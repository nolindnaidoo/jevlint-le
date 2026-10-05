import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _reset, _state } from '../__mocks__/vscode';
import { CONFIG_DEFAULTS, getConfiguration } from '../config/config';
import { createLinter } from './linter';

// No real text is known to make a reader throw, so one is made to here. The
// guard exists for the one nobody has found yet.
vi.mock('../lint/lint', async (original) => {
	const real = await original<typeof import('../lint/lint')>();
	return {
		...real,
		lintText: (text: string, ...rest: []) => {
			if (text.includes('POISON')) throw new RangeError('reader failed');
			return real.lintText(text, ...rest);
		},
	};
});

const BARE = `const q = { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Charges', technical: 'Faults' } };`;

function doc(text: string) {
	const self = {
		text,
		languageId: 'typescript',
		uri: vscode.Uri.parse('file:///a.ts'),
		getText: () => self.text,
		positionAt: (offset: number) => new vscode.Position(0, offset),
	};
	return self as unknown as vscode.TextDocument & { text: string };
}

const shown = () => _state.diagnostics.get('file:///a.ts') ?? [];

function linter() {
	return createLinter({
		getConfiguration,
		lintOptionsFor: () => ({ options: getConfiguration().lint }),
		onResult: () => {},
	});
}

beforeEach(() => _reset());

describe('a file the reader fails on', () => {
	it('loses its old findings and says why, where it used to throw', () => {
		const document = doc(BARE);
		const lint = linter();
		lint.lint(document);
		expect(shown()).toHaveLength(1);

		document.text = `${BARE} // POISON`;
		expect(lint.lint(document)).toEqual({
			kind: 'skipped',
			reason: 'error',
			detail: 'This file could not be linted: reader failed',
		});
		expect(shown()).toEqual([]);
		expect(lint.problemFor(document)).toContain('could not be linted');

		// Once the text can be read again the problem is gone.
		document.text = BARE;
		lint.lint(document);
		expect(lint.problemFor(document)).toBeUndefined();
		expect(shown()).toHaveLength(1);
	});
});

describe('the size limit', () => {
	it('counts bytes, as the command line does, and not characters', () => {
		// Under the limit in characters, over it in bytes.
		const accented = 'é'.repeat(CONFIG_DEFAULTS.maxFileSizeBytes / 2 + 1);
		expect(accented.length).toBeLessThan(CONFIG_DEFAULTS.maxFileSizeBytes);
		expect(linter().lint(doc(`${BARE}\n// ${accented}`))).toEqual({
			kind: 'skipped',
			reason: 'size',
		});
	});
});
