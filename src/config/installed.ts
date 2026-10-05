import { type ConfigFs, parent, under } from './projectConfig';

/** The name this tool is published under on npm, and so the folder a project installs it in. */
export const PACKAGE = 'jevlint-le';

/** A copy of this tool that a project has installed for itself. */
export type Installed = Readonly<{
	/** The package's own folder, inside a `node_modules`. */
	dir: string;
	version: string;
	/** The file its manifest names as the library, when it names one. Releases before 0.3.0 name none. */
	library: string | undefined;
}>;

type Manifest = Readonly<{ version: string; main: string | undefined }>;

function manifestIn(fs: ConfigFs, path: string): Manifest | undefined {
	try {
		const { version, main } = JSON.parse(fs.read(path));
		if (typeof version !== 'string') return undefined;
		return { version, main: typeof main === 'string' ? main : undefined };
	} catch {
		// A manifest that cannot be read or parsed is a copy that cannot be named.
		return undefined;
	}
}

/**
 * The copy of this tool installed nearest to a file: in its folder's
 * `node_modules` or one above it, no higher than `stop`. Only the manifest
 * is read here. Nothing in the package is run.
 */
export function findInstalled(
	file: string,
	stop: string | undefined,
	fs: ConfigFs,
): Installed | undefined {
	let dir = parent(file);
	while (true) {
		const packageDir = under(dir, 'node_modules', PACKAGE);
		const manifest = under(packageDir, 'package.json');
		if (fs.isFile(manifest)) {
			const read = manifestIn(fs, manifest);
			if (!read) return undefined;
			return {
				dir: packageDir,
				version: read.version,
				// Kept inside the package's folder, whatever the manifest says.
				library: read.main
					? under(packageDir, read.main.replace(/^\.?[\\/]+/, ''))
					: undefined,
			};
		}
		const above = parent(dir);
		if (dir === stop || above === dir) return undefined;
		dir = above;
	}
}
