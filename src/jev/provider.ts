import type { Failure, Reply } from './client';
import type { ReviewRequest } from './reviews';

/**
 * The two APIs a check can be put to. Both take typed questions over evidence
 * and answer with probabilities, so one review runs on either; the shape on
 * the wire and the key differ, and this is the only file that knows how.
 *
 * The cutoffs in `reviews.ts` were set on `jev-1.13.0`. A finding from any
 * other model says so, until that model is calibrated the same way.
 */
export type Provider = Readonly<{
	id: 'typesafe' | 'openai';
	/** Who is sent the request. */
	vendor: string;
	/** What answers it, as the messages name it. */
	model: string;
	endpoint: string;
	/** The environment variable the command line and the editor read the key from. */
	envKey: string;
	/** Dollars per million input tokens on the vendor's price page, and when that was read. */
	pricePerMillionTokens: number;
	pricedOn: string;
	/** The request as the vendor's API wants it. */
	toBody: (request: ReviewRequest) => unknown;
	/** The answers as `runReview` reads them, or why the body is not an answer. */
	fromBody: (body: unknown) => Reply | Failure;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

type Noul = Readonly<{
	instructions: string;
	criteria?: Readonly<{ true: string; false: string }>;
}>;

// A check's id can hold dots, `JEV303.0`, and what OpenAI allows in a name is
// not published. Dots travel as a run of underscores no id contains.
const DOT = '__';
const toWireName = (id: string): string => id.split('.').join(DOT);
const fromWireName = (name: string): string => name.split(DOT).join('.');

// A predicate has no criteria field, so what yes and no mean goes into the
// instructions, where the model reads it either way.
function toPredicate(name: string, question: Noul) {
	const criteria = question.criteria;
	const instructions = criteria
		? `${question.instructions}\n\nAnswer yes when: ${criteria.true}\nAnswer no when: ${criteria.false}`
		: question.instructions;
	return { type: 'predicate', name: toWireName(name), instructions };
}

const TYPESAFE: Provider = Object.freeze({
	id: 'typesafe',
	vendor: 'TypeSafe',
	model: 'Jev',
	endpoint: 'https://api.typesafe.ai/v1/systemone',
	envKey: 'TYPESAFE_API_KEY',
	// TypeSafe's published price on the day the checks were calibrated.
	pricePerMillionTokens: 0.042,
	pricedOn: '2026-10-04',
	toBody: (request) => request,
	fromBody: (body) => {
		if (!isRecord(body) || !isRecord(body.answers))
			return { kind: 'garbled', detail: 'the answer was not a Jev reply' };
		const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
		return {
			model: typeof body.model === 'string' ? body.model : '',
			answers: body.answers as Reply['answers'],
			inputTokens: typeof usage === 'number' ? usage : 0,
		};
	},
});

const OPENAI: Provider = Object.freeze({
	id: 'openai',
	vendor: 'OpenAI',
	model: 'Luna',
	endpoint: 'https://api.openai.com/v1/decisions',
	envKey: 'OPENAI_API_KEY',
	// OpenAI's published price for the Decisions API beta.
	pricePerMillionTokens: 0.1,
	pricedOn: '2026-10-08',
	toBody: (request) => ({
		model: request.model,
		// The API takes text, not an object. Written out as JSON it reads the same.
		input: JSON.stringify(request.state, null, 2),
		questions: Object.entries(request.questions).map(([name, question]) =>
			toPredicate(name, question as Noul),
		),
	}),
	fromBody: (body) => {
		if (!isRecord(body) || !Array.isArray(body.answers))
			return { kind: 'garbled', detail: 'the answer was not a Luna reply' };
		const answers: Record<string, { noul?: number }> = {};
		for (const answer of body.answers) {
			if (!isRecord(answer) || typeof answer.name !== 'string') continue;
			// A refusal is no answer, so the check does not fire. It is not a wrong one.
			if (typeof answer.probability !== 'number') continue;
			answers[fromWireName(answer.name)] = { noul: answer.probability };
		}
		const usage = isRecord(body.usage) ? body.usage.input_tokens : undefined;
		return {
			model: typeof body.model === 'string' ? body.model : 'gpt-6-luna',
			answers,
			inputTokens: typeof usage === 'number' ? usage : 0,
		};
	},
});

export const PROVIDERS: ReadonlyArray<Provider> = Object.freeze([
	TYPESAFE,
	OPENAI,
]);

/** Who answers a model id: `gpt-6-luna` and its dated versions are OpenAI's, everything else is Jev. */
export function providerFor(model: string): Provider {
	return /^gpt-6-luna/.test(model) ? OPENAI : TYPESAFE;
}

/** True where the cutoffs were set: a Jev version. A finding from any other model carries a caveat. */
export function isCalibrated(model: string): boolean {
	return providerFor(model).id === 'typesafe';
}

/** A message written for Jev, reworded for the model that answered. */
export function forProvider(message: string, provider: Provider): string {
	return provider.id === 'typesafe'
		? message
		: message.replace(/\bJev\b/g, provider.model);
}
