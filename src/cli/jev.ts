import type { Failure } from '../jev/client';
import {
	DEFAULT_MAX_CALLS,
	DEFAULT_MODEL,
	type Network,
	planReview,
	type ReviewSettings,
	runReview,
} from '../jev/review';
import { syntaxForPath } from '../lint/lint';
import type { LintOptions } from '../types';
import type { CliOptions } from './args';
import type { FileReport, JevTotals } from './format';

/** One file's share of the run: the settings it is checked under and what that will send. */
type Share = Readonly<{
	report: FileReport;
	settings: ReviewSettings;
	requests: number;
}>;

export type JevPlan = Readonly<{
	shares: ReadonlyArray<Share>;
	totals: JevTotals;
}>;

export type JevRun = Readonly<{
	reports: ReadonlyArray<FileReport>;
	totals: JevTotals;
	failure: Failure | undefined;
	stopped: boolean;
}>;

export const FAILURES: Readonly<Record<Failure['kind'], string>> =
	Object.freeze({
		key: 'TypeSafe rejected the API key',
		rejected: 'TypeSafe rejected the request',
		busy: 'TypeSafe is busy or the rate limit was reached',
		server: 'TypeSafe had an error of its own',
		network: 'Could not reach TypeSafe',
		garbled: 'TypeSafe did not answer with a Jev reply',
	});

/**
 * What the run would send, file by file, with nothing sent. The limit is for
 * the whole run: each file is planned with what the files before it left.
 * The run sends from these same shares, so the count said is the count sent.
 */
export function planJev(
	reports: ReadonlyArray<FileReport>,
	optionsFor: (file: string) => LintOptions | string,
	options: CliOptions,
): JevPlan | string {
	const model = options.jevModel ?? DEFAULT_MODEL;
	let left = options.jevMaxCalls ?? DEFAULT_MAX_CALLS;
	let totals: JevTotals = {
		sent: false,
		planned: 0,
		answered: 0,
		runtime: 0,
		overLimit: 0,
		estimatedInputTokens: 0,
		inputTokens: 0,
		model,
		state: false,
	};
	const shares: Share[] = [];
	for (const report of reports) {
		const lint = optionsFor(report.path);
		if (typeof lint === 'string') return lint;
		const settings: ReviewSettings = {
			lint,
			model,
			sendState: options.jevSendState,
			maxCalls: left,
		};
		const plan = planReview(
			report.text,
			syntaxForPath(report.path) ?? 'js',
			settings,
		);
		left -= plan.requests;
		totals = {
			...totals,
			planned: totals.planned + plan.requests,
			runtime: totals.runtime + plan.unreadable,
			overLimit: totals.overLimit + plan.overLimit,
			estimatedInputTokens: totals.estimatedInputTokens + plan.inputTokens,
			state: totals.state || plan.sendsState,
		};
		shares.push({ report, settings, requests: plan.requests });
	}
	return { shares, totals };
}

function withFindings(share: Share, found: FileReport['findings']): FileReport {
	if (!found.length) return share.report;
	return {
		...share.report,
		findings: [...share.report.findings, ...found].sort(
			(a, b) => a.span.start - b.span.start,
		),
	};
}

/** Sends the plan. A failed request or a stop ends the sending, and the files after it are left as linted. */
export async function runJev(
	plan: JevPlan,
	network: Network,
	quiet: boolean,
): Promise<JevRun> {
	const reports: FileReport[] = [];
	let { totals } = plan;
	let failure: Failure | undefined;
	let stopped = false;
	for (const share of plan.shares) {
		if (failure || stopped || !share.requests) {
			reports.push(share.report);
			continue;
		}
		const run = await runReview(
			share.report.text,
			syntaxForPath(share.report.path) ?? 'js',
			share.settings,
			network,
		);
		totals = {
			...totals,
			answered: totals.answered + run.asked,
			inputTokens: totals.inputTokens + run.inputTokens,
			model: run.model || totals.model,
		};
		failure = run.failure;
		stopped = run.cancelled;
		reports.push(
			withFindings(
				share,
				quiet
					? run.findings.filter((finding) => finding.severity === 'error')
					: run.findings,
			),
		);
	}
	return { reports, totals: { ...totals, sent: true }, failure, stopped };
}
