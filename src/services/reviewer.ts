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
	| Readonly<{ kind: 'failed'; failure: Failure; asked: number }>
	/** The document was edited or closed during the run, so what Jev said is about text that is gone. */
	| Readonly<{ kind: 'stale'; asked: number }>;

export type Reviewer = Readonly<{
	/** `lint` is the settings that apply to the document: its rule levels and what it ignores. */
	plan: (document: vscode.TextDocument, lint: LintOptions) => ReviewPlan;
	review: (
		document: vscode.TextDocument,
		key: string,
		signal: AbortSignal,
		lint: LintOptions,
	) => Promise<ReviewOutcome>;
	/** True while a run on this document is still sending. */
	running: (document: vscode.TextDocument) => boolean;
	/** Drops what Jev said about a document, and ends a run on it that is still sending. */
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

	// The runs still sending, by document. An edit or a close marks the run as
	// overtaken and stops it, so it neither spends more nor reports on old text.
	const flights = new Map<
		string,
		{ stop: AbortController; overtaken: boolean }
	>();

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
		const id = document.uri.toString();
		const flight = { stop: new AbortController(), overtaken: false };
		const stop = () => flight.stop.abort();
		signal.addEventListener('abort', stop, { once: true });
		if (signal.aborted) stop();
		flights.set(id, flight);
		const run = await runReview(
			document.getText(),
			syntaxFor(document.languageId),
			settings(lint),
			{ fetch: deps.fetch, wait: deps.wait, key, signal: flight.stop.signal },
		).finally(() => {
			flights.delete(id);
			signal.removeEventListener('abort', stop);
		});
		if (flight.overtaken) return { kind: 'stale', asked: run.asked };
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
		running: (document: vscode.TextDocument) =>
			flights.has(document.uri.toString()),
		clear: (document: vscode.TextDocument) => {
			const flight = flights.get(document.uri.toString());
			if (flight) {
				flight.overtaken = true;
				flight.stop.abort();
			}
			collection.delete(document.uri);
		},
		dispose: () => {
			for (const flight of flights.values()) flight.stop.abort();
			collection.dispose();
		},
	});
}
