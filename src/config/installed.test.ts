import { describe, expect, it } from 'vitest';
import { findInstalled } from './installed';

const disk = (tree: Record<string, string>) => ({
	isFile: (path: string) => path in tree,
	read: (path: string) => {
		const text = tree[path];
		if (text === undefined) throw new Error('ENOENT');
		return text;
	},
});

describe('the copy a project has installed', () => {
	it('is found in the node_modules nearest the file', () => {
		const fs = disk({
			'/work/node_modules/jevlint-le/package.json': '{ "version": "0.1.0" }',
			'/work/app/node_modules/jevlint-le/package.json':
				'{ "version": "0.2.0" }',
		});
		expect(findInstalled('/work/app/src/q.ts', '/work', fs)).toEqual({
			dir: '/work/app/node_modules/jevlint-le',
			version: '0.2.0',
			library: undefined,
		});
		expect(findInstalled('/work/lib/q.ts', '/work', fs)?.version).toBe('0.1.0');
	});

	it('is not looked for above the folder the search stops at', () => {
		const fs = disk({
			'/node_modules/jevlint-le/package.json': '{ "version": "9.9.9" }',
		});
		expect(findInstalled('/work/app/q.ts', '/work', fs)).toBeUndefined();
		// A file opened on its own has no folder to stop at.
		expect(findInstalled('/work/app/q.ts', undefined, fs)?.version).toBe(
			'9.9.9',
		);
	});

	it('is nothing when the project has none', () => {
		expect(findInstalled('/work/q.ts', '/work', disk({}))).toBeUndefined();
	});

	it.each([
		['not JSON', '{'],
		['no version', '{ "name": "jevlint-le" }'],
		['a version that is not text', '{ "version": 2 }'],
	])('is nothing when its manifest holds %s', (_, manifest) => {
		const fs = disk({ '/work/node_modules/jevlint-le/package.json': manifest });
		expect(findInstalled('/work/q.ts', '/work', fs)).toBeUndefined();
	});

	it('names the library file when the manifest has one, inside the package', () => {
		const at = '/work/node_modules/jevlint-le/package.json';
		const found = (main: string) =>
			findInstalled(
				'/work/q.ts',
				'/work',
				disk({ [at]: `{ "version": "0.3.0", "main": "${main}" }` }),
			)?.library;
		expect(found('lib.js')).toBe('/work/node_modules/jevlint-le/lib.js');
		expect(found('./lib.js')).toBe('/work/node_modules/jevlint-le/lib.js');
		// An absolute path in a manifest must not send the editor elsewhere.
		expect(found('/etc/lib.js')).toBe(
			'/work/node_modules/jevlint-le/etc/lib.js',
		);
	});

	it('reads Windows paths as they are written', () => {
		const fs = disk({
			'C:\\work\\node_modules\\jevlint-le\\package.json':
				'{ "version": "0.2.0" }',
		});
		expect(findInstalled('C:\\work\\src\\q.ts', 'C:\\work', fs)?.dir).toBe(
			'C:\\work\\node_modules\\jevlint-le',
		);
	});
});
