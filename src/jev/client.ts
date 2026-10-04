import type { ReviewRequest } from './reviews';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

type Response = Readonly<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
	text: () => Promise<string>;
}>;

export type Fetch = (
	url: string,
	init: Readonly<{
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	}>,
) => Promise<Response>;

export type Reply = Readonly<{
	model: string;
	answers: Readonly<Record<string, Readonly<{ noul?: number }>>>;
	inputTokens: number;
}>;

export type Failure = Readonly<{
	kind: 'key' | 'rejected' | 'busy' | 'network';
	detail: string;
}>;

type Deps = Readonly<{
	fetch: Fetch;
	key: string;
	wait: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}>;

const ATTEMPTS = 3;
const BUSY: ReadonlySet<number> = new Set([429, 529]);

const FAILURES: Readonly<Record<number, Failure['kind']>> = Object.freeze({
	401: 'key',
	403: 'key',
	422: 'rejected',
});

function toReply(body: unknown): Reply {
	const data = body as {
		model?: string;
		answers?: Reply['answers'];
		usage?: { input_tokens?: number };
	};
	return {
		model: data.model ?? '',
		answers: data.answers ?? {},
		inputTokens: data.usage?.input_tokens ?? 0,
	};
}

async function attempt(
	deps: Deps,
	request: ReviewRequest,
): Promise<Reply | Failure> {
	const response = await deps
		.fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${deps.key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(request),
			...(deps.signal ? { signal: deps.signal } : {}),
		})
		.catch((error: unknown) => ({
			kind: 'network' as const,
			detail: error instanceof Error ? error.message : String(error),
		}));
	if ('kind' in response) return response;
	if (response.ok) return toReply(await response.json());
	if (BUSY.has(response.status))
		return { kind: 'busy', detail: String(response.status) };
	return {
		kind: FAILURES[response.status] ?? 'rejected',
		// The body can echo the request. The status is enough to act on.
		detail: String(response.status),
	};
}

export function isFailure(result: Reply | Failure): result is Failure {
	return 'kind' in result;
}

/**
 * Sends one review to Jev. Retries only when the service says it is busy, a
 * fixed number of times, and never on a bad key or a rejected request, which
 * no retry can fix.
 */
export async function ask(
	deps: Deps,
	request: ReviewRequest,
): Promise<Reply | Failure> {
	let result = await attempt(deps, request);
	for (let tries = 1; tries < ATTEMPTS; tries += 1) {
		if (!isFailure(result) || result.kind !== 'busy') return result;
		await deps.wait(1000 * 2 ** tries);
		result = await attempt(deps, request);
	}
	return result;
}
