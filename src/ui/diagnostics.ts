import * as vscode from 'vscode';
import { pageFor, RULES } from '../lint/rules';
import type { ReportedFinding, Severity, Span } from '../types';

export const SOURCE = 'jevlint-le';

const SEVERITIES: Readonly<Record<Severity, vscode.DiagnosticSeverity>> =
	Object.freeze({
		hint: vscode.DiagnosticSeverity.Hint,
		info: vscode.DiagnosticSeverity.Information,
		warning: vscode.DiagnosticSeverity.Warning,
		error: vscode.DiagnosticSeverity.Error,
	});

export function toRange(
	document: vscode.TextDocument,
	span: Span,
): vscode.Range {
	return new vscode.Range(
		document.positionAt(span.start),
		document.positionAt(span.end),
	);
}

/** The page for a rule, for the rules the copy this extension carries knows. */
export const ownDocs = (code: string): string | undefined =>
	code in RULES ? pageFor(code) : undefined;

/**
 * `docsFor` is the docs link for a rule as the copy that found it knows it.
 * A project's own copy can have a rule this extension has never heard of.
 */
export function toDiagnostic(
	document: vscode.TextDocument,
	finding: ReportedFinding,
	docsFor: (code: string) => string | undefined = ownDocs,
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(
		toRange(document, finding.span),
		finding.message,
		SEVERITIES[finding.severity],
	);
	diagnostic.source = SOURCE;
	const docs = docsFor(finding.code);
	diagnostic.code = docs
		? { value: finding.code, target: vscode.Uri.parse(docs) }
		: finding.code;
	return diagnostic;
}
