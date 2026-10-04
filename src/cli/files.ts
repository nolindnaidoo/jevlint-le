import { syntaxForPath } from '../lint/lint';

export type Entry = Readonly<{ kind: 'file' | 'dir'; size: number }>;

/** The filesystem the tool needs, passed in so a test can supply one. */
export type Files = Readonly<{
	stat: (path: string) => Entry | undefined;
	/** The names inside a directory. */
	list: (path: string) => ReadonlyArray<string>;
	read: (path: string) => string;
}>;

export type Found =
	| Readonly<{ ok: true; paths: ReadonlyArray<string> }>
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

function walk(dir: string, files: Files): ReadonlyArray<string> {
	return [...files.list(dir)].sort().flatMap((name) => {
		const path = join(dir, name);
		const entry = files.stat(path);
		if (entry?.kind === 'dir')
			return SKIPPED_DIRS.has(name) ? [] : walk(path, files);
		return entry && syntaxForPath(path) ? [path] : [];
	});
}

/**
 * The files to lint. A directory is searched for the file types the tool
 * reads. A file named outright must be one of those types: quietly skipping
 * it would report a clean run on something that was never read.
 */
export function findFiles(paths: ReadonlyArray<string>, files: Files): Found {
	const found: string[] = [];
	for (const path of paths) {
		const entry = files.stat(path);
		if (!entry)
			return { ok: false, error: `No such file or directory: ${path}` };
		if (entry.kind === 'dir') {
			found.push(...walk(path, files));
			continue;
		}
		if (!syntaxForPath(path))
			return { ok: false, error: `Not a file type jevlint-le reads: ${path}` };
		found.push(path);
	}
	return { ok: true, paths: [...new Set(found)] };
}
