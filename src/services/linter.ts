import * as vscode from 'vscode';
import type { Configuration } from '../config/config';
import { lintText, syntaxFor } from '../lint/lint';
import type { LintResult } from '../types';
import { ownDocs, SOURCE, toDiagnostic } from '../ui/diagnostics';
import type { Engine } from './engines';
import type { Resolved } from './projectConfigs';

export type Outcome =
	| Readonly<{ kind: 'linted'; result: LintResult }>
	| Readonly<{ kind: 'skipped'; reason: 'language' | 'size' | 'excluded' }>
	/** The settings file that governs this document could not be used, or the reader failed on the file. */
	| Readonly<{ kind: 'skipped'; reason: 'config' | 'error'; detail: string }>;

type LintRequest = Readonly<{
	/**
	 * The workspace command opens each file only to read it, and the editor
	 * closes such documents on its own a few minutes later. Without this the
	 * findings of a workspace run would vanish file by file while the user was
	 * still reading them.
	 */
	keep: boolean;
}>;

export type Linter = Readonly<{
	lint: (document: vscode.TextDocument, options?: LintRequest) => Outcome;
	schedule: (document: vscode.TextDocument) => void;
	/** A document closed. Its findings go, unless a workspace run asked to keep them. */
	forget: (document: vscode.TextDocument) => void;
	/** Drops every finding, kept or not, before a fresh workspace run. */
	reset: () => void;
	resultFor: (document: vscode.TextDocument) => LintResult | undefined;
	/** Why a document was not linted, when its settings file is the reason. */
	problemFor: (document: vscode.TextDocument) => string | undefined;
	dispose: () => void;
}>;

type Deps = Readonly<{
	/** The linter to use for a document. Without one it is the copy the extension carries. */
	engineFor?: (
		document: vscode.TextDocument,
	) => Pick<Engine, 'lint' | 'docsFor'>;
	getConfiguration: () => Configuration;
	lintOptionsFor: (document: vscode.TextDocument) => Resolved;
	onResult: (document: vscode.TextDocument) => void;
}>;

export const LANGUAGES: ReadonlyArray<string> = Object.freeze([
	'json',
	'jsonc',
	'javascript',
	'javascriptreact',
	'typescript',
	'typescriptreact',
	'python',
	'rust',
	'go',
]);

const DEBOUNCE_MS = 250;
const BUNDLED = Object.freeze({ lint: lintText, docsFor: ownDocs });

export function createLinter(deps: Deps): Linter {
	const collection = vscode.languages.createDiagnosticCollection(SOURCE);
	const results = new Map<string, LintResult>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const kept = new Set<string>();
	const problems = new Map<string, string>();

	const clear = (document: vscode.TextDocument): void => {
		const key = document.uri.toString();
		clearTimeout(timers.get(key));
		timers.delete(key);
		results.delete(key);
		problems.delete(key);
		collection.delete(document.uri);
	};

	const lint = (
		document: vscode.TextDocument,
		options?: LintRequest,
	): Outcome => {
		if (!LANGUAGES.includes(document.languageId))
			return { kind: 'skipped', reason: 'language' };
		const config = deps.getConfiguration();
		const text = document.getText();
		// Bytes, as the command line counts them, so the two skip the same files.
		if (Buffer.byteLength(text, 'utf8') > config.maxFileSizeBytes) {
			// Stale diagnostics on a file that is no longer being read would be a claim nobody checked.
			clear(document);
			deps.onResult(document);
			return { kind: 'skipped', reason: 'size' };
		}
		if (options?.keep) kept.add(document.uri.toString());
		const resolved = deps.lintOptionsFor(document);
		if ('problem' in resolved) {
			// Linting under other settings would report what the command line would not.
			clear(document);
			problems.set(document.uri.toString(), resolved.problem);
			deps.onResult(document);
			return { kind: 'skipped', reason: 'config', detail: resolved.problem };
		}
		problems.delete(document.uri.toString());
		const engine = deps.engineFor?.(document) ?? BUNDLED;
		if (resolved.excluded) {
			// Left out by the project's settings file, as the command line leaves it out.
			clear(document);
			deps.onResult(document);
			return { kind: 'skipped', reason: 'excluded' };
		}
		let result: LintResult;
		try {
			result = engine.lint(
				text,
				resolved.options,
				syntaxFor(document.languageId),
			);
		} catch (error) {
			// This runs in a timer or an event, where a throw is lost and the old
			// findings would stay on screen as if the file had been read.
			const detail = `This file could not be linted: ${error instanceof Error ? error.message : String(error)}`;
			clear(document);
			problems.set(document.uri.toString(), detail);
			deps.onResult(document);
			return { kind: 'skipped', reason: 'error', detail };
		}
		results.set(document.uri.toString(), result);
		collection.set(
			document.uri,
			result.findings.map((finding) =>
				toDiagnostic(document, finding, engine.docsFor),
			),
		);
		deps.onResult(document);
		return { kind: 'linted', result };
	};

	const schedule = (document: vscode.TextDocument): void => {
		const key = document.uri.toString();
		clearTimeout(timers.get(key));
		timers.set(
			key,
			setTimeout(() => {
				timers.delete(key);
				lint(document);
			}, DEBOUNCE_MS),
		);
	};

	return Object.freeze({
		lint,
		schedule,
		forget: (document: vscode.TextDocument) => {
			if (kept.has(document.uri.toString())) return;
			clear(document);
		},
		reset: () => {
			kept.clear();
			results.clear();
			problems.clear();
			collection.clear();
		},
		resultFor: (document: vscode.TextDocument) =>
			results.get(document.uri.toString()),
		problemFor: (document: vscode.TextDocument) =>
			problems.get(document.uri.toString()),
		dispose: () => {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
			results.clear();
			collection.dispose();
		},
	});
}
