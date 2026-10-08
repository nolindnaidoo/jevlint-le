import { readQuestions } from '../lint/lint';
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
import { ask, type Failure, type Fetch, isFailure, type Reply } from './client';
import { type QuestionLiteral, toLiteral, toPlain } from './literal';
import {
	forProvider,
	isCalibrated,
	type Provider,
	providerFor,
} from './provider';
import {
	buildRequest,
	buildRequestReview,
	REQUEST_REVIEWS,
	REVIEWS,
	type ReviewRequest,
	readAnswers,
	readRequestAnswers,
} from './reviews';

/** Pinned, because the cutoffs of the Jev-backed checks were set on this version. */
export const DEFAULT_MODEL = 'jev-1.13.0';
export const DEFAULT_MAX_CALLS = 25;

/** What a run needs to know, wherever it is run from. */
export type ReviewSettings = Readonly<{
	/** The rule levels and what is ignored, for the file under review. */
	lint: LintOptions;
	model: string;
	/** Send the state written out in the file to the checks that read it. */
	sendState: boolean;
	/** The most requests this text may cost. */
	maxCalls: number;
}>;

/** What a run would send, worked out before anything is sent. */
export type ReviewPlan = Readonly<{
	requests: number;
	/** An estimate. See `CHARS_PER_TOKEN`. */
	inputTokens: number;
	/** Questions with a part built at runtime. Jev is never shown a question with holes. */
	unreadable: number;
	/** Requests left out because the run would pass the limit. */
	overLimit: number;
	/** True when the plan includes the state written in the file. */
	sendsState: boolean;
}>;

export type ReviewRun = Readonly<{
	/** Requests Jev answered. */
	asked: number;
	/** What Jev flagged in what it answered, less anything silenced in the file or the settings. */
	findings: ReadonlyArray<ReportedFinding>;
	inputTokens: number;
	model: string;
	/** True when the run was stopped before every request was answered. */
	cancelled: boolean;
	/** Why the run ended early, when a request failed. */
	failure: Failure | undefined;
}>;

export type Network = Readonly<{
	fetch: Fetch;
	key: string;
	wait: (ms: number) => Promise<void>;
	signal: AbortSignal;
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

function enabledReviews(lint: LintOptions): ReadonlySet<string> {
	return new Set(
		REVIEW_CODES.filter(
			(code) => (lint.rules[code] ?? RULES[code].severity) !== 'off',
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

// The number behind a finding, and, from a model the cutoffs were not set on, that fact.
function rated(probability: number, provider: Provider): string {
	const number = `(${provider.model} put this at ${probability.toFixed(2)}.)`;
	return isCalibrated(DEFAULT_MODEL) && provider.id !== 'typesafe'
		? `${number} The cutoff was set on ${DEFAULT_MODEL}, not on ${provider.model}.`
		: number;
}

function questionJob(
	question: Question,
	request: ReviewRequest,
	provider: Provider,
): Job {
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
					forProvider(
						`${found.message}${named ? ` Jev points at ${named}.` : ''} ${rated(found.probability, provider)}`,
						provider,
					),
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
	provider: Provider,
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
					forProvider(
						`${message} ${rated(found.probability, provider)}`,
						provider,
					),
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
	settings: ReviewSettings,
	syntax: Syntax,
): Prepared {
	const extraction: Extraction = readQuestions(text, syntax);
	const enabled = enabledReviews(settings.lint);
	const { model } = settings;
	const provider = providerFor(model);
	const stateOf = (map: QuestionMap | undefined): unknown =>
		settings.sendState && map?.state ? toPlain(map.state) : undefined;
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
		jobs.push(questionJob(question, request, provider));
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
		jobs.push(mapJob(map, Object.keys(literals), request, provider));
	}

	const limit = settings.maxCalls;
	return {
		jobs: jobs.slice(0, limit),
		unreadable,
		overLimit: Math.max(0, jobs.length - limit),
		sendsState,
	};
}

/** What a run on this text would send. Nothing is sent. */
export function planReview(
	text: string,
	syntax: Syntax,
	settings: ReviewSettings,
): ReviewPlan {
	const prepared = prepare(text, settings, syntax);
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
}

/** Sends what `planReview` counted, one request at a time, and reads the answers. */
export async function runReview(
	text: string,
	syntax: Syntax,
	settings: ReviewSettings,
	network: Network,
): Promise<ReviewRun> {
	const { rules, ignore } = settings.lint;
	const findings: ReportedFinding[] = [];
	const report: Report = (code, message, span, questionId) => {
		const severity = rules[code] ?? RULES[code].severity;
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
	let failure: Failure | undefined;
	for (const job of prepare(text, settings, syntax).jobs) {
		if (network.signal.aborted) break;
		const reply = await ask(network, job.request);
		// A request the user cut off fails too, and that is not a failure to report.
		if (network.signal.aborted && isFailure(reply)) break;
		// A bad key or a rejected request will fail the same way on every question.
		if (isFailure(reply)) {
			failure = reply;
			break;
		}
		asked += 1;
		inputTokens += reply.inputTokens;
		model = reply.model;
		job.read(reply, report);
	}
	const isSuppressed = suppressor(text);
	return {
		asked,
		findings: findings.filter(
			(finding: Finding) =>
				!isSuppressed(finding) &&
				!ignore.includes(`${finding.code}:${finding.questionId}`),
		),
		inputTokens,
		model,
		cancelled: network.signal.aborted,
		failure,
	};
}
