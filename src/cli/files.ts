import { syntaxForPath } from '../lint/lint';

export type Entry = Readonly<{
	kind: 'file' | 'dir';
	size: number;
	/** True when the path is a symbolic link to what `kind` says. */
	link?: boolean;
}>;

/** The filesystem the tool needs, passed in so a test can supply one. */
export type Files = Readonly<{
	stat: (path: string) => Entry | undefined;
	/** The names inside a directory. */
	list: (path: string) => ReadonlyArray<string>;
	read: (path: string) => string;
}>;

export type Found =
	| Readonly<{
			ok: true;
			paths: ReadonlyArray<string>;
			/** Folders and files that could not be looked at, such as one without permission. */
			unread: ReadonlyArray<string>;
	  }>
	| Readonly<{ ok: false; error: string }>;

// Never worth reading: installed packages, build output and version control.
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	'node_modules',
	'dist',
	'out',
	'build',
	'coverage',
	'.git',
	'.venv',
	'venv',
	'__pycache__',
	'site-packages',
	'target',
]);

function join(dir: string, name: string): string {
	if (dir === '.') return name;
	return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// One folder that cannot be listed must not end the run. It is named, because
// a silent skip reads as "clean".
function attempt<T>(
	read: () => T,
	path: string,
	unread: string[],
): T | undefined {
	try {
		return read();
	} catch {
		unread.push(path);
		return undefined;
	}
}

function walk(
	dir: string,
	files: Files,
	unread: string[],
): ReadonlyArray<string> {
	const names = attempt(() => files.list(dir), dir, unread) ?? [];
	return [...names].sort().flatMap((name) => {
		const path = join(dir, name);
		const entry = attempt(() => files.stat(path), path, unread);
		if (entry?.kind !== 'dir')
			return entry && syntaxForPath(path) ? [path] : [];
		// A linked folder can lead back to one above it, and then the search never ends.
		if (entry.link || SKIPPED_DIRS.has(name)) return [];
		return walk(path, files, unread);
	});
}

/**
 * The files to lint. A directory is searched for the file types the tool
 * reads. A file named outright must be one of those types: quietly skipping
 * it would report a clean run on something that was never read.
 */
export function findFiles(paths: ReadonlyArray<string>, files: Files): Found {
	const found: string[] = [];
	const unread: string[] = [];
	for (const path of paths) {
		const entry = files.stat(path);
		if (!entry)
			return { ok: false, error: `No such file or directory: ${path}` };
		if (entry.kind === 'dir') {
			found.push(...walk(path, files, unread));
			continue;
		}
		if (!syntaxForPath(path))
			return { ok: false, error: `Not a file type jevlint-le reads: ${path}` };
		found.push(path);
	}
	return { ok: true, paths: [...new Set(found)], unread };
}
