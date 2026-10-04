import * as vscode from 'vscode';
import type { LintResult, ReportedFinding } from '../types';
import { SOURCE, toRange } from './diagnostics';

type Deps = Readonly<{
	resultFor: (document: vscode.TextDocument) => LintResult | undefined;
}>;

function codeOf(diagnostic: vscode.Diagnostic): string {
	const code = diagnostic.code;
	return typeof code === 'object' && code !== null
		? String(code.value)
		: String(code);
}

function matching(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
	result: LintResult,
): ReportedFinding | undefined {
	const start = document.offsetAt(diagnostic.range.start);
	return result.findings.find(
		(finding) =>
			finding.code === codeOf(diagnostic) && finding.span.start === start,
	);
}

function toFix(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
	finding: ReportedFinding,
): vscode.CodeAction | undefined {
	if (!finding.fix) return undefined;
	const action = new vscode.CodeAction(
		finding.fix.title,
		vscode.CodeActionKind.QuickFix,
	);
	const edit = new vscode.WorkspaceEdit();
	for (const change of finding.fix.edits)
		edit.replace(document.uri, toRange(document, change.span), change.text);
	action.edit = edit;
	action.diagnostics = [diagnostic];
	// A real fix is offered ahead of silencing the finding.
	action.isPreferred = true;
	return action;
}

// Strict JSON has no comments, so a finding there is silenced in the settings file.
const COMMENTS: Readonly<Record<string, string>> = Object.freeze({
	jsonc: '//',
	javascript: '//',
	javascriptreact: '//',
	typescript: '//',
	typescriptreact: '//',
	rust: '//',
	go: '//',
	python: '#',
});

function inserting(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
	title: string,
	offset: number,
	line: string,
): vscode.CodeAction {
	const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
	const at = document.positionAt(offset);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(document.uri, new vscode.Range(at, at), line);
	action.edit = edit;
	action.diagnostics = [diagnostic];
	return action;
}

/** The two ways to silence a finding with a comment: on its line, or for the file. */
function toSilencers(
	document: vscode.TextDocument,
	diagnostic: vscode.Diagnostic,
	finding: ReportedFinding,
): ReadonlyArray<vscode.CodeAction> {
	const comment = COMMENTS[document.languageId];
	// Inside a string a comment would become part of the JSON.
	if (!comment || finding.inString) return [];
	const text = document.getText();
	const lineStart = text.lastIndexOf('\n', finding.span.start - 1) + 1;
	const indent = /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
	// A script's first line names its interpreter and must stay first.
	const top = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
	return [
		inserting(
			document,
			diagnostic,
			`Disable ${finding.code} for this line`,
			lineStart,
			`${indent}${comment} jevlint-le-disable-next-line ${finding.code}\n`,
		),
		inserting(
			document,
			diagnostic,
			`Disable ${finding.code} for this file`,
			top,
			`${comment} jevlint-le-disable ${finding.code}\n`,
		),
	];
}

/**
 * Quick fixes come from the lint result held for the document, matched to the
 * diagnostic by rule and position. The editor hands back copies of
 * diagnostics, so the fix cannot ride on the diagnostic object itself.
 */
export function createCodeActionProvider(
	deps: Deps,
): vscode.CodeActionProvider {
	return Object.freeze({
		provideCodeActions: (
			document: vscode.TextDocument,
			_range: vscode.Range,
			context: vscode.CodeActionContext,
		) => {
			const result = deps.resultFor(document);
			if (!result) return [];
			return context.diagnostics
				.filter((diagnostic) => diagnostic.source === SOURCE)
				.flatMap((diagnostic) => {
					const finding = matching(document, diagnostic, result);
					if (!finding) return [];
					const fix = toFix(document, diagnostic, finding);
					return [
						...(fix ? [fix] : []),
						...toSilencers(document, diagnostic, finding),
					];
				});
		},
	});
}
