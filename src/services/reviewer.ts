import * as vscode from 'vscode';
import type { Configuration } from '../config/config';
import type { Failure, Fetch } from '../jev/client';
import {
	planReview,
	type ReviewPlan,
	type ReviewSettings,
	runReview,
} from '../jev/review';
import { syntaxFor } from '../lint/lint';
import type { LintOptions } from '../types';
import { toDiagnostic } from '../ui/diagnostics';

export type { ReviewPlan };

export type ReviewOutcome =
	| Readonly<{
			kind: 'done';
			/** Requests Jev answered. */
			asked: number;
			/** True when the user stopped the run before every request was answered. */
			cancelled: boolean;
			findings: number;
			inputTokens: number;
			model: string;
	  }>
	| Readonly<{ kind: 'failed'; failure: Failure; asked: number }>;

export type Reviewer = Readonly<{
	/** `lint` is the settings that apply to the document: its rule levels and what it ignores. */
	plan: (document: vscode.TextDocument, lint: LintOptions) => ReviewPlan;
	review: (
		document: vscode.TextDocument,
		key: string,
		signal: AbortSignal,
		lint: LintOptions,
	) => Promise<ReviewOutcome>;
	clear: (document: vscode.TextDocument) => void;
	dispose: () => void;
}>;

type Deps = Readonly<{
	getConfiguration: () => Configuration;
	fetch: Fetch;
	wait: (ms: number) => Promise<void>;
}>;

/** Runs the Jev checks in `jev/review.ts` over a document and shows what they find. */
export function createReviewer(deps: Deps): Reviewer {
	// A separate collection, so linting as you type never wipes what a paid check found.
	const collection =
		vscode.languages.createDiagnosticCollection('jevlint-le-jev');

	const settings = (lint: LintOptions): ReviewSettings => {
		const { model, sendState, maxCalls } = deps.getConfiguration().jev;
		return { lint, model, sendState, maxCalls };
	};

	const plan = (document: vscode.TextDocument, lint: LintOptions): ReviewPlan =>
		planReview(
			document.getText(),
			syntaxFor(document.languageId),
			settings(lint),
		);

	const review = async (
		document: vscode.TextDocument,
		key: string,
		signal: AbortSignal,
		lint: LintOptions,
	): Promise<ReviewOutcome> => {
		const run = await runReview(
			document.getText(),
			syntaxFor(document.languageId),
			settings(lint),
			{ fetch: deps.fetch, wait: deps.wait, key, signal },
		);
		// What was answered before a failure is dropped: the message says the run failed.
		if (run.failure)
			return { kind: 'failed', failure: run.failure, asked: run.asked };
		collection.set(
			document.uri,
			run.findings.map((finding) => toDiagnostic(document, finding)),
		);
		return {
			kind: 'done',
			asked: run.asked,
			cancelled: run.cancelled,
			findings: run.findings.length,
			inputTokens: run.inputTokens,
			model: run.model,
		};
	};

	return Object.freeze({
		plan,
		review,
		clear: (document: vscode.TextDocument) => collection.delete(document.uri),
		dispose: () => collection.dispose(),
	});
}
