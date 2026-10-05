import { createRequire } from 'node:module';

const load = createRequire(__filename);

/**
 * Loads a file as a module, fresh. Node keeps what it has loaded, so without
 * the clearing a project that upgraded its copy would go on being linted by
 * the old one until the editor was restarted.
 */
export function loadModule(path: string): unknown {
	delete load.cache[load.resolve(path)];
	return load(path);
}
