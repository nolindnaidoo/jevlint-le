#!/usr/bin/env node
/**
 * Assembles the two npm packages from one source: npm/ holds the bundled
 * command line and the library, mcp/ holds the server-only bundle. Each gets
 * the license and a manifest whose version is the root's. The version is
 * written here and nowhere else, so the packages and the extension cannot
 * claim different ones.
 */
const { copyFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { buildSync } = require('esbuild');

const root = join(__dirname, '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

function bundle(entry, outfile, banner) {
	buildSync({
		entryPoints: [join(root, 'src', ...entry)],
		bundle: true,
		outfile,
		format: 'cjs',
		platform: 'node',
		target: 'node20',
		...(banner ? { banner: { js: '#!/usr/bin/env node' } } : {}),
	});
}

function manifest(dir) {
	const out = join(root, dir);
	copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
	const path = join(out, 'package.json');
	const written = JSON.parse(readFileSync(path, 'utf8'));
	written.version = version;
	writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
	return written.name;
}

const npm = join(root, 'npm');
bundle(['cli', 'main.ts'], join(npm, 'cli.js'), true);
// The same linter as a library, for the editor extension to load from a
// project's node_modules. No shebang: it is required, never run.
bundle(['lib.ts'], join(npm, 'lib.js'), false);

// The server alone, reached with no flag, for agent hosts and the registry.
const mcp = join(root, 'mcp');
bundle(['cli', 'mcpMain.ts'], join(mcp, 'server.js'), true);

const names = [manifest('npm'), manifest('mcp')];
console.log(`${names.join(' and ')} built at ${version}`);
