import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadModule } from './loadModule';

describe('loading a project copy', () => {
	it('loads what is on disk now, not what was loaded before', () => {
		const file = join(
			mkdtempSync(join(tmpdir(), 'jevlint-le-load-')),
			'lib.js',
		);
		writeFileSync(file, 'module.exports = { api: 1, version: "one" };');
		expect(loadModule(file)).toEqual({ api: 1, version: 'one' });
		// The project upgrades its copy, at the same path.
		writeFileSync(file, 'module.exports = { api: 1, version: "two" };');
		expect(loadModule(file)).toEqual({ api: 1, version: 'two' });
	});

	it('throws on a file that is not there, for the caller to fall back', () => {
		expect(() =>
			loadModule(join(tmpdir(), 'jevlint-le-no-such-lib.js')),
		).toThrow();
	});
});
