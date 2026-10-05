#!/usr/bin/env node
/**
 * Assembles the npm package in npm/: the bundled command line, the library, the license,
 * and a manifest whose version is the root's. The version is written here and
 * nowhere else, so the package and the extension cannot claim different ones.
 */
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildSync } = require('esbuild');

const root = join(__dirname, '..');
const out = join(root, 'npm');

buildSync({
	entryPoints: [join(root, 'src', 'cli', 'main.ts')],
	bundle: true,
	outfile: join(out, 'cli.js'),
	format: 'cjs',
	platform: 'node',
	target: 'node20',
	banner: { js: '#!/usr/bin/env node' },
});
// The same linter as a library, for the editor extension to load from a
// project's node_modules. No shebang: it is required, never run.
buildSync({
	entryPoints: [join(root, 'src', 'lib.ts')],
	bundle: true,
	outfile: join(out, 'lib.js'),
	format: 'cjs',
	platform: 'node',
	target: 'node20',
});
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const manifestPath = join(out, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`npm/ built at ${manifest.version}`);
