import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Fetch } from '../jev/client';
import type { Entry } from './files';
import { serve } from './mcp';
import { EXIT } from './run';

/**
 * The server-only process, published as `jevlint-le-mcp`. It is the server
 * `jevlint-le --mcp` runs, reached with no flag, so a client that installs
 * by package name cannot start the command line by mistake and sit waiting
 * on a linter that has already exited. The network and the environment are
 * handed in for check_with_jev and probe_question, which are the only tools
 * that use them; the rest never touch either.
 */

function stat(path: string): Entry | undefined {
	const found = statSync(path, { throwIfNoEntry: false });
	if (!found) return undefined;
	return {
		kind: found.isDirectory() ? 'dir' : 'file',
		size: found.size,
		link: lstatSync(path).isSymbolicLink(),
	};
}

// The manifest sits beside the bundle in the package.
function version(): string {
	const manifest = readFileSync(join(__dirname, 'package.json'), 'utf8');
	return String(JSON.parse(manifest).version);
}

// What the server must never do, made to throw so that a path reaching it is
// a failed call with a reason, never a quiet write.
const never = (what: string) => (): never => {
	throw new Error(`The MCP server ${what}.`);
};

// A request in flight is cut off by the first interrupt, as on the command line.
function stopSignal(): AbortSignal {
	const stop = new AbortController();
	process.once('SIGINT', () => stop.abort());
	return stop.signal;
}

// A client that closes the pipe is not an error of this server's.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
	if (error.code !== 'EPIPE') throw error;
});

serve({
	files: {
		stat,
		list: (path) => readdirSync(path),
		read: (path) => readFileSync(path, 'utf8'),
		write: never('writes nothing'),
	},
	stdin: never('reads standard input as requests only'),
	lines: () => createInterface({ input: process.stdin }),
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	version: version(),
	// Read only for an API key, and only by the two tools that send.
	env: process.env,
	terminal: false,
	fetch: ((url, init) => fetch(url, init)) as Fetch,
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	stopSignal,
}).catch((error: unknown) => {
	process.stderr.write(`jevlint-le-mcp: ${String(error)}\n`);
	process.exitCode = EXIT.unusable;
});
