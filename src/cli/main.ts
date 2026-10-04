import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Entry } from './files';
import { EXIT, run } from './run';

function stat(path: string): Entry | undefined {
	const found = statSync(path, { throwIfNoEntry: false });
	if (!found) return undefined;
	return { kind: found.isDirectory() ? 'dir' : 'file', size: found.size };
}

async function stdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString('utf8');
}

// In the npm package the manifest sits beside the bundle. In the extension
// the bundle is in dist/, one level under it.
function version(): string {
	const beside = join(__dirname, 'package.json');
	const path = existsSync(beside)
		? beside
		: join(__dirname, '..', 'package.json');
	return String(JSON.parse(readFileSync(path, 'utf8')).version);
}

run(process.argv.slice(2), {
	files: {
		stat,
		list: (path) => readdirSync(path),
		read: (path) => readFileSync(path, 'utf8'),
	},
	stdin,
	lines: () => createInterface({ input: process.stdin }),
	out: (text) => process.stdout.write(text),
	err: (text) => process.stderr.write(text),
	version: version(),
})
	.then((status) => {
		process.exitCode = status;
	})
	.catch((error: unknown) => {
		process.stderr.write(`jevlint-le: ${String(error)}\n`);
		process.exitCode = EXIT.unusable;
	});
