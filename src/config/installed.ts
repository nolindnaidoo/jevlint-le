import { type ConfigFs, parent, under } from './projectConfig';

/** The name this tool is published under on npm, and so the folder a project installs it in. */
export const PACKAGE = 'jevlint-le';

/** A copy of this tool that a project has installed for itself. */
export type Installed = Readonly<{
	/** The package's own folder, inside a `node_modules`. */
	dir: string;
	version: string;
}>;

function versionIn(fs: ConfigFs, manifest: string): string | undefined {
	try {
		const version = JSON.parse(fs.read(manifest)).version;
		return typeof version === 'string' ? version : undefined;
	} catch {
		// A manifest that cannot be read or parsed is a copy that cannot be named.
		return undefined;
	}
}

/**
 * The copy of this tool installed nearest to a file: in its folder's
 * `node_modules` or one above it, no higher than `stop`. Only the manifest
 * is read. Nothing in the package is run.
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
			const version = versionIn(fs, manifest);
			return version === undefined ? undefined : { dir: packageDir, version };
		}
		const above = parent(dir);
		if (dir === stop || above === dir) return undefined;
		dir = above;
	}
}
