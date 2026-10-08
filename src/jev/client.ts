import { providerFor } from './provider';
import type { ReviewRequest } from './reviews';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Where the editor and the command line both look for a Jev key in the environment. */
export const ENV_KEY = 'TYPESAFE_API_KEY';

type Response = Readonly<{
	ok: boolean;
	status: number;
	headers?: Readonly<{ get: (name: string) => string | null }>;
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
	/**
	 * `key` and `rejected` are the caller's to fix. `busy` and `server` are
	 * TypeSafe's, and are tried again. `network` got no answer, and `garbled`
	 * got one that is not a Jev reply.
	 */
	kind: 'key' | 'rejected' | 'busy' | 'server' | 'network' | 'garbled';
	detail: string;
	/** How long TypeSafe asked to be left alone, when it said. */
	retryAfterMs?: number;
}>;

type Deps = Readonly<{
	fetch: Fetch;
	key: string;
	wait: (ms: number) => Promise<void>;
	signal?: AbortSignal;
}>;

const ATTEMPTS = 3;
const BUSY: ReadonlySet<number> = new Set([429, 529]);
// A request that has had no answer by now is not going to get one. Without
// this a stalled connection holds a CI job until the job itself is killed.
export const TIMEOUT_MS = 30_000;
// TypeSafe may ask for longer than is worth waiting in an editor or a CI job.
const LONGEST_WAIT_MS = 30_000;
const RETRIED: ReadonlySet<Failure['kind']> = new Set(['busy', 'server']);

const FAILURES: Readonly<Record<number, Failure['kind']>> = Object.freeze({
	401: 'key',
	403: 'key',
	422: 'rejected',
});

function retryAfterMs(response: Response): number | undefined {
	const seconds = Number(response.headers?.get('retry-after') ?? '');
	return Number.isFinite(seconds) && seconds > 0
		? Math.min(seconds * 1000, LONGEST_WAIT_MS)
		: undefined;
}

function refusal(response: Response): Failure {
	const detail = String(response.status);
	const wait = retryAfterMs(response);
	const again = wait === undefined ? {} : { retryAfterMs: wait };
	if (BUSY.has(response.status)) return { kind: 'busy', detail, ...again };
	if (response.status >= 500 || response.status === 408)
		return { kind: 'server', detail, ...again };
	// The body can echo the request. The status is enough to act on.
	return { kind: FAILURES[response.status] ?? 'rejected', detail };
}

async function attempt(
	deps: Deps,
	request: ReviewRequest,
): Promise<Reply | Failure> {
	// One signal for the request: the caller's stop, or the time running out.
	const cut = new AbortController();
	const stop = () => cut.abort();
	const timer = setTimeout(stop, TIMEOUT_MS);
	deps.signal?.addEventListener('abort', stop, { once: true });
	if (deps.signal?.aborted) stop();
	const provider = providerFor(request.model);
	// The body is read inside the same limit: a reply can stall after its headers.
	const answered = async (): Promise<Reply | Failure> => {
		const response = await deps.fetch(provider.endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${deps.key}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(provider.toBody(request)),
			signal: cut.signal,
		});
		if (!response.ok) return refusal(response);
		const body = await response.json().catch((error: unknown) => {
			// A body cut off by the stop or the limit is no answer, not a bad one.
			if (cut.signal.aborted) throw error;
			return undefined;
		});
		// A proxy or a login page can answer 200 with something that is not a reply.
		// Reading that as "no findings" would report a clean check that never ran.
		return provider.fromBody(body);
	};
	return answered()
		.catch((error: unknown): Failure => {
			const timedOut = cut.signal.aborted && !deps.signal?.aborted;
			return {
				kind: 'network',
				detail: timedOut
					? `no answer in ${TIMEOUT_MS / 1000} seconds`
					: error instanceof Error
						? error.message
						: String(error),
			};
		})
		.finally(() => {
			clearTimeout(timer);
			deps.signal?.removeEventListener('abort', stop);
		});
}

// A wait the caller's stop ends at once, so a cancel is not held for the backoff.
function pause(deps: Deps, ms: number): Promise<void> {
	const { signal } = deps;
	if (!signal) return deps.wait(ms);
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			signal.removeEventListener('abort', done);
			resolve();
		};
		signal.addEventListener('abort', done, { once: true });
		void deps.wait(ms).then(done, done);
	});
}

export function isFailure(result: Reply | Failure): result is Failure {
	return 'kind' in result;
}

/**
 * Sends one review to the model its `model` names, Jev or Luna. Retries only
 * when the fault is the vendor's, a fixed number of times, and never on a bad
 * key or a rejected request, which no retry can fix. It waits as long as the
 * vendor asks, up to a limit.
 */
export async function ask(
	deps: Deps,
	request: ReviewRequest,
): Promise<Reply | Failure> {
	let result = await attempt(deps, request);
	for (let tries = 1; tries < ATTEMPTS; tries += 1) {
		if (!isFailure(result) || !RETRIED.has(result.kind)) return result;
		await pause(deps, result.retryAfterMs ?? 1000 * 2 ** tries);
		if (deps.signal?.aborted) return result;
		result = await attempt(deps, request);
	}
	return result;
}
