import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, type Fetch, isFailure, TIMEOUT_MS } from './client';

const REQUEST = { state: {}, model: 'jev-1.13.0', questions: {} };
const REPLY = { model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 7 } };

const answering = (
	status: number,
	body: () => Promise<unknown> = async () => REPLY,
	headers: Record<string, string> = {},
) =>
	vi.fn(async () => ({
		ok: status === 200,
		status,
		headers: { get: (name: string) => headers[name] ?? null },
		json: body,
		text: async () => '',
	}));

function deps(fetch: unknown, signal?: AbortSignal) {
	const waits: number[] = [];
	return {
		waits,
		fetch: fetch as Fetch,
		key: 'k',
		wait: async (ms: number) => {
			waits.push(ms);
		},
		...(signal ? { signal } : {}),
	};
}

afterEach(() => vi.useRealTimers());

describe('a reply', () => {
	it('is read when it is one', async () => {
		expect(await ask(deps(answering(200)), REQUEST)).toEqual({
			model: 'jev-1.13.0',
			answers: {},
			inputTokens: 7,
		});
	});

	it.each([
		['a body that is not JSON', () => Promise.reject(new SyntaxError('<'))],
		['null', async () => null],
		['a list', async () => []],
		['no answers', async () => ({ model: 'jev-1.13.0' })],
		['answers that are not a map', async () => ({ answers: 'none' })],
	])('is a failure and not a clean check when it holds %s', async (_, body) => {
		const result = await ask(deps(answering(200, body)), REQUEST);
		expect(result).toMatchObject({ kind: 'garbled' });
	});
});

describe('a refusal', () => {
	it.each([
		[401, 'key'],
		[403, 'key'],
		[404, 'rejected'],
		[422, 'rejected'],
	])('with %i is not tried again', async (status, kind) => {
		const fetch = answering(status);
		expect(await ask(deps(fetch), REQUEST)).toMatchObject({ kind });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it.each([
		[429, 'busy'],
		[529, 'busy'],
		[500, 'server'],
		[503, 'server'],
		[408, 'server'],
	])(
		"with %i is TypeSafe's fault, and is tried three times",
		async (status, kind) => {
			const fetch = answering(status);
			const world = deps(fetch);
			expect(await ask(world, REQUEST)).toMatchObject({ kind });
			expect(fetch).toHaveBeenCalledTimes(3);
			expect(world.waits).toEqual([2000, 4000]);
		},
	);

	it('waits as long as TypeSafe asks, up to a limit', async () => {
		const asked = deps(answering(429, undefined, { 'retry-after': '7' }));
		await ask(asked, REQUEST);
		expect(asked.waits).toEqual([7000, 7000]);

		const greedy = deps(answering(429, undefined, { 'retry-after': '3600' }));
		await ask(greedy, REQUEST);
		expect(greedy.waits).toEqual([30_000, 30_000]);
	});

	it('succeeds when a later try does', async () => {
		const replies = [answering(503), answering(200)];
		const fetch = vi.fn(() => (replies.shift() ?? answering(200))());
		expect(isFailure(await ask(deps(fetch), REQUEST))).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});

describe('a request that gets no answer', () => {
	// Settles only when its signal says to, as a stalled connection does.
	const stalled = () =>
		vi.fn(
			(_url: string, init: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal?.addEventListener('abort', () =>
						reject(new Error('aborted')),
					);
				}),
		);

	it('is given up on after the time limit, and says so', async () => {
		vi.useFakeTimers();
		const fetch = stalled();
		const asked = ask(deps(fetch), REQUEST);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(await asked).toEqual({
			kind: 'network',
			detail: 'no answer in 30 seconds',
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('is also given up on when the body stalls after the headers', async () => {
		vi.useFakeTimers();
		const fetch = vi.fn(
			async (_url: string, init: { signal?: AbortSignal }) => ({
				ok: true,
				status: 200,
				json: () =>
					new Promise((_resolve, reject) => {
						init.signal?.addEventListener('abort', () =>
							reject(new Error('aborted')),
						);
					}),
				text: async () => '',
			}),
		);
		const asked = ask(deps(fetch), REQUEST);
		await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
		expect(await asked).toEqual({
			kind: 'network',
			detail: 'no answer in 30 seconds',
		});
	});

	it('is not called a timeout when the caller stopped it', async () => {
		const stop = new AbortController();
		const asked = ask(deps(stalled(), stop.signal), REQUEST);
		stop.abort();
		expect(await asked).toEqual({ kind: 'network', detail: 'aborted' });
	});
});

describe('a stop during the wait before another try', () => {
	it('ends the wait at once and sends nothing more', async () => {
		const stop = new AbortController();
		const fetch = answering(429);
		const result = await ask(
			{
				fetch: fetch as unknown as Fetch,
				key: 'k',
				signal: stop.signal,
				// A wait that would hold the run for as long as it is asked to.
				wait: () => {
					stop.abort();
					return new Promise(() => {});
				},
			},
			REQUEST,
		);
		expect(result).toMatchObject({ kind: 'busy' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
