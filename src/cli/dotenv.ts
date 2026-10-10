import type { Files } from './files';

/**
 * The API key for a vendor, found the way the MCP server looks for it: in
 * the environment the server was started with, then in the project's own
 * `.env.local`, then `.env`, in the directory the client started it in. Never
 * from a tool argument: a key passed as an argument lands in the agent's
 * transcript and the host's logs, which no key should.
 */

// Later wins: a local override beats the shared file, as dotenv tooling reads them.
const FILES: ReadonlyArray<string> = ['.env.local', '.env'];

export type FoundKey = Readonly<{
	key: string;
	/** Where it came from, for a message. Never the key itself. */
	source: string;
}>;

function unquote(value: string): string {
	const quoted = /^(['"`])(.*)\1\s*(?:#.*)?$/.exec(value);
	if (quoted) return quoted[2] as string;
	// Bare values end at a comment, which needs a space before the hash.
	return value.replace(/\s+#.*$/, '').trim();
}

/** `KEY=value` lines, with `export`, quotes and `#` comments as dotenv reads them. */
export function parseDotEnv(text: string): Readonly<Record<string, string>> {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
			line,
		);
		if (!match) continue;
		values[match[1] as string] = unquote(match[2] as string);
	}
	return values;
}

/** The key named `envKey`, or undefined when no place holds one. */
export function keyFrom(
	envKey: string,
	env: Readonly<Record<string, string | undefined>>,
	files: Files,
): FoundKey | undefined {
	const fromEnv = env[envKey]?.trim();
	if (fromEnv) return { key: fromEnv, source: 'the environment' };
	for (const path of FILES) {
		if (files.stat(path)?.kind !== 'file') continue;
		const value = parseDotEnv(files.read(path))[envKey]?.trim();
		if (value) return { key: value, source: path };
	}
	return undefined;
}

/** Where a key is looked for, for the sentence that says none was found. */
export function keyPlaces(envKey: string): string {
	return `${envKey} in the environment the server was started with, or in ${FILES.join(' or ')} in its working directory`;
}
