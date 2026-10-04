import * as vscode from 'vscode';
import type { Configuration } from '../config/config';
import {
	ask,
	type Failure,
	type Fetch,
	isFailure,
	type Reply,
} from '../jev/client';
import { type QuestionLiteral, toLiteral, toPlain } from '../jev/literal';
import {
	buildRequest,
	buildRequestReview,
	REQUEST_REVIEWS,
	REVIEWS,
	type ReviewRequest,
	readAnswers,
	readRequestAnswers,
} from '../jev/reviews';
import { readQuestions, syntaxFor } from '../lint/lint';
import { RULES } from '../lint/rules';
import { suppressor } from '../lint/suppress';
import type {
	Extraction,
	Finding,
	LintOptions,
	Question,
	QuestionMap,
	ReportedFinding,
	RuleCode,
	Span,
	Syntax,
} from '../types';
import { toDiagnostic } from '../ui/diagnostics';

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

/** What a run would send, worked out before anything is sent. */
export type ReviewPlan = Readonly<{
	requests: number;
	/** An estimate. See `CHARS_PER_TOKEN`. */
	inputTokens: number;
	/** Questions with a part built at runtime. Jev is never shown a question with holes. */
	unreadable: number;
	/** Requests left out because the run would pass `jev.maxCalls`. */
	overLimit: number;
	/** True when the plan includes the state written in the file. */
	sendsState: boolean;
}>;

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

type Report = (
	code: RuleCode,
	message: string,
	span: Span,
	questionId: string | undefined,
) => void;

/** One request and what to do with its answers. */
type Job = Readonly<{
	request: ReviewRequest;
	read: (reply: Reply, report: Report) => void;
}>;

type Prepared = Readonly<{
	jobs: ReadonlyArray<Job>;
	unreadable: number;
	overLimit: number;
	sendsState: boolean;
}>;

const REVIEW_CODES: ReadonlyArray<RuleCode> = [
	...REVIEWS.map((review) => review.code),
	'JEV310',
	'JEV312',
];

// Measured once: the calibration run's request bodies came to about 2.2
// characters per input token. Two is used so the estimate errs high.
const CHARS_PER_TOKEN = 2;

function enabledReviews(config: Configuration): ReadonlySet<string> {
	return new Set(
		REVIEW_CODES.filter(
			(code) => (config.lint.rules[code] ?? RULES[code].severity) !== 'off',
		),
	);
}

// The option or level at a position, as the thing to underline and a name to call it by.
function entryOf(
	question: Question,
	index: number,
): Readonly<{ name: string; span: Span }> | undefined {
	const criteria = question.criteria;
	if (criteria?.kind === 'object') {
		const prop = criteria.props[index];
		return prop && { name: prop.key, span: prop.keySpan };
	}
	if (criteria?.kind !== 'array') return undefined;
	const item = criteria.items[index];
	return item && { name: `level ${index}`, span: item.span };
}

const rated = (probability: number) =>
	`(Jev put this at ${probability.toFixed(2)}.)`;

function questionJob(question: Question, request: ReviewRequest): Job {
	return {
		request,
		read: (reply, report) => {
			for (const found of readAnswers(reply.answers)) {
				const places = found.culprits.flatMap(
					(index) => entryOf(question, index) ?? [],
				);
				const named = places.map((place) => `'${place.name}'`).join(' and ');
				report(
					found.code,
					`${found.message}${named ? ` Jev points at ${named}.` : ''} ${rated(found.probability)}`,
					places[0]?.span ?? question.anchor,
					question.id,
				);
			}
		},
	};
}

function mapJob(
	map: QuestionMap,
	ids: ReadonlyArray<string>,
	request: ReviewRequest,
): Job {
	const spanOf = (id: string) =>
		map.entries.find((entry) => entry.id === id)?.idSpan;
	return {
		request,
		read: (reply, report) => {
			for (const found of readRequestAnswers(ids, reply.answers)) {
				const pair = found.code === 'JEV310';
				const span = pair
					? spanOf(found.second)
					: (map.stateKey ?? map.entries[0]?.idSpan);
				if (!span) continue;
				const message = pair
					? REQUEST_REVIEWS.JEV310.message(found.first)
					: REQUEST_REVIEWS.JEV312.message;
				report(
					found.code,
					`${message} ${rated(found.probability)}`,
					span,
					pair ? found.second : undefined,
				);
			}
		},
	};
}

/**
 * Everything a run would send, in order, built without sending anything. The
 * confirmation the user sees and the run itself both come from this, so the
 * count they agree to is the count that is sent.
 */
function prepare(
	text: string,
	config: Configuration,
	syntax: Syntax,
): Prepared {
	const extraction: Extraction = readQuestions(text, syntax);
	const enabled = enabledReviews(config);
	const model = config.jev.model;
	const stateOf = (map: QuestionMap | undefined): unknown =>
		config.jev.sendState && map?.state ? toPlain(map.state) : undefined;
	const jobs: Job[] = [];
	let unreadable = 0;
	let sendsState = false;

	for (const question of extraction.questions) {
		const literal = toLiteral(question);
		if (!literal) {
			unreadable += 1;
			continue;
		}
		const map =
			question.map === undefined ? undefined : extraction.maps[question.map];
		const siblings = (map?.entries ?? [])
			.map((entry) => entry.id)
			.filter((id) => id !== question.id);
		const state = stateOf(map);
		const request = buildRequest(literal, model, enabled, { siblings, state });
		if (!request) continue;
		sendsState ||= 'state' in request.state;
		jobs.push(questionJob(question, request));
	}

	for (const [index, map] of extraction.maps.entries()) {
		const literals: Record<string, QuestionLiteral> = {};
		for (const question of extraction.questions) {
			const literal = question.map === index ? toLiteral(question) : undefined;
			if (literal && question.id !== undefined) literals[question.id] = literal;
		}
		const request = buildRequestReview(literals, model, enabled, stateOf(map));
		if (!request) continue;
		sendsState ||= 'state' in request.state;
		jobs.push(mapJob(map, Object.keys(literals), request));
	}

	const limit = config.jev.maxCalls;
	return {
		jobs: jobs.slice(0, limit),
		unreadable,
		overLimit: Math.max(0, jobs.length - limit),
		sendsState,
	};
}

export function createReviewer(deps: Deps): Reviewer {
	// A separate collection, so linting as you type never wipes what a paid check found.
	const collection =
		vscode.languages.createDiagnosticCollection('jevlint-le-jev');

	const plan = (
		document: vscode.TextDocument,
		lint: LintOptions,
	): ReviewPlan => {
		const prepared = prepare(
			document.getText(),
			{ ...deps.getConfiguration(), lint },
			syntaxFor(document.languageId),
		);
		const chars = prepared.jobs.reduce(
			(sum, job) => sum + JSON.stringify(job.request).length,
			0,
		);
		return {
			requests: prepared.jobs.length,
			inputTokens: Math.ceil(chars / CHARS_PER_TOKEN),
			unreadable: prepared.unreadable,
			overLimit: prepared.overLimit,
			sendsState: prepared.sendsState,
		};
	};

	const review = async (
		document: vscode.TextDocument,
		key: string,
		signal: AbortSignal,
		lint: LintOptions,
	): Promise<ReviewOutcome> => {
		const config = { ...deps.getConfiguration(), lint };
		const text = document.getText();
		const findings: ReportedFinding[] = [];
		const report: Report = (code, message, span, questionId) => {
			const severity = config.lint.rules[code] ?? RULES[code].severity;
			if (severity === 'off') return;
			findings.push({
				code,
				message,
				span,
				questionId,
				fix: undefined,
				severity,
			});
		};
		let asked = 0;
		let inputTokens = 0;
		let model = '';
		for (const job of prepare(text, config, syntaxFor(document.languageId))
			.jobs) {
			if (signal.aborted) break;
			const reply = await ask(
				{ fetch: deps.fetch, key, wait: deps.wait, signal },
				job.request,
			);
			// A request the user cut off fails too, and that is not a failure to report.
			if (signal.aborted && isFailure(reply)) break;
			// A bad key or a rejected request will fail the same way on every question.
			if (isFailure(reply)) return { kind: 'failed', failure: reply, asked };
			asked += 1;
			inputTokens += reply.inputTokens;
			model = reply.model;
			job.read(reply, report);
		}
		const isSuppressed = suppressor(text);
		const kept = findings.filter(
			(finding: Finding) =>
				!isSuppressed(finding) &&
				!config.lint.ignore.includes(`${finding.code}:${finding.questionId}`),
		);
		collection.set(
			document.uri,
			kept.map((finding) => toDiagnostic(document, finding)),
		);
		return {
			kind: 'done',
			asked,
			cancelled: signal.aborted,
			findings: kept.length,
			inputTokens,
			model,
		};
	};

	return Object.freeze({
		plan,
		review,
		clear: (document: vscode.TextDocument) => collection.delete(document.uri),
		dispose: () => collection.dispose(),
	});
}
