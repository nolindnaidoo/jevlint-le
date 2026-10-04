import * as vscode from 'vscode';
import { RULES } from '../lint/rules';
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

export function toDiagnostic(
	document: vscode.TextDocument,
	finding: ReportedFinding,
): vscode.Diagnostic {
	const diagnostic = new vscode.Diagnostic(
		toRange(document, finding.span),
		finding.message,
		SEVERITIES[finding.severity],
	);
	diagnostic.source = SOURCE;
	diagnostic.code = {
		value: finding.code,
		target: vscode.Uri.parse(RULES[finding.code].docs),
	};
	return diagnostic;
}
