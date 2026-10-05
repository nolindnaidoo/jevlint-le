import { describe, expect, it, vi } from 'vitest';
import type { Fetch } from '../jev/client';
import { type Io, run } from './run';

// No real text is known to make a reader throw, so one is made to here. The
// guard exists for the one nobody has found yet.
vi.mock('../lint/lint', async (original) => {
	const real = await original<typeof import('../lint/lint')>();
	return {
		...real,
		lintText: (text: string, ...rest: []) => {
			if (text.includes('POISON')) throw new RangeError('reader failed');
			return real.lintText(text, ...rest);
		},
	};
});

const BAD = `{ "questions": { "team": { "type": "choice", "instructions": "Which team?", "criteria": { "billing": "Charges", "technical": "Faults" } } } }`;

async function cli(args: string[], tree: Record<string, string>) {
	const out: string[] = [];
	const io: Io = {
		files: {
			stat: (path) =>
				path === '.'
					? { kind: 'dir', size: 0 }
					: tree[path] === undefined
						? undefined
						: { kind: 'file', size: 1 },
			list: () => Object.keys(tree),
			read: (path) => tree[path] ?? '',
			write: () => {},
		},
		stdin: async () => '',
		lines: async function* () {},
		out: (text) => out.push(text),
		err: () => {},
		version: '0',
		env: {},
		terminal: false,
		fetch: (async () => {
			throw new Error('offline');
		}) as unknown as Fetch,
		wait: async () => {},
		stopSignal: () => new AbortController().signal,
	};
	await run(args, io);
	return { out: out.join('') };
}

describe('a file the reader fails on', () => {
	it('is named, and does not take the other files with it', async () => {
		const result = await cli(['.'], { 'a.json': BAD, 'b.json': 'POISON' });
		expect(result.out).toContain('JEV004');
		expect(result.out).toContain('1 path could not be read: b.json.');
	});
});
