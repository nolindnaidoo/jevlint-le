#!/usr/bin/env node
/**
 * Records assets/demo.gif: the extension at work in a real VS Code.
 *
 * Playwright starts the VS Code build the integration tests download, with a
 * profile of its own and the packaged extension installed, and records the
 * window itself. Nothing here touches the VS Code you use, and what is on
 * your screen while it runs does not matter.
 *
 *   bun run test:integration   # once, to download VS Code
 *   bun run package
 *   node scripts/record-editor-demo.mjs
 *
 * The file it opens and the settings it uses are in assets/demo/editor/. The
 * built-in TypeScript extension is switched off for the recording: the demo
 * imports an SDK that is not installed, and its "cannot find module" would be
 * the first thing a viewer saw. macOS only, and it needs ffmpeg.
 *
 * The take edits the file and never saves it. Hot exit must stay on in the
 * demo settings: with it off, closing the window stops on a save dialog.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
	execFileSync('node', ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: root, encoding: 'utf8' }),
);
const vsix = join(root, 'release', `${manifest.name}-${manifest.version}.vsix`);
const SIZE = { width: 1200, height: 760 };

function refuse(message) {
	console.error(`record-editor-demo: ${message}`);
	process.exit(2);
}

if (process.platform !== 'darwin') refuse('written for macOS.');
if (!existsSync(vsix)) refuse(`${vsix} is not built. Run \`bun run package\`.`);
const builds = existsSync(join(root, '.vscode-test'))
	? readdirSync(join(root, '.vscode-test')).filter((name) => name.startsWith('vscode-'))
	: [];
const build = builds.sort().at(-1);
if (!build) refuse('no VS Code build. Run `bun run test:integration` once to download one.');
const app = join(root, '.vscode-test', build, 'Visual Studio Code.app', 'Contents');

// VS Code opens a socket inside the profile, and a socket path has a short
// limit. The system temp directory is short enough; most others are not.
const work = mkdtempSync(join(tmpdir(), 'jvd-'));
const profile = join(work, 'u');
const extensions = join(work, 'e');
const workspace = join(work, 'parcels');
const video = join(work, 'v');
mkdirSync(join(profile, 'User'), { recursive: true });
mkdirSync(workspace);
cpSync(join(root, 'assets/demo/editor/settings.json'), join(profile, 'User/settings.json'));
cpSync(join(root, 'assets/demo/editor/route.ts'), join(workspace, 'route.ts'));
execFileSync(
	join(app, 'Resources/app/bin/code'),
	['--install-extension', vsix, '--extensions-dir', extensions, '--user-data-dir', profile],
	{ stdio: 'ignore' },
);

const editor = await electron.launch({
	executablePath: join(app, 'MacOS/Code'),
	args: [
		workspace,
		join(workspace, 'route.ts'),
		`--user-data-dir=${profile}`,
		`--extensions-dir=${extensions}`,
		'--disable-extension=vscode.typescript-language-features',
		'--disable-workspace-trust',
		'--skip-welcome',
		'--skip-release-notes',
		'--disable-updates',
	],
	recordVideo: { dir: video, size: SIZE },
});
const page = await editor.firstWindow();
const opened = Date.now();
const pause = (ms) => page.waitForTimeout(ms);
// Findings are found by their underline, not by the text under it. How the
// editor splits a line into spans changes with the grammar in use.
const WARNING = '.cdr.squiggly-warning';
const INFO = '.cdr.squiggly-info';
async function centre(selector, index = 0) {
	const box = await page.locator(selector).nth(index).boundingBox();
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function pointAt(selector, index) {
	const { x, y } = await centre(selector, index);
	await page.mouse.move(x, y, { steps: 12 });
}
async function quickFix(selector, index) {
	const { x, y } = await centre(selector, index);
	await page.mouse.click(x, y);
	await pause(500);
	await page.keyboard.press('Meta+.');
	await pause(1800);
	await page.keyboard.press('Enter');
	await pause(2200);
}

let start = 0;
let length = 0;
// Closed whatever happens, so a failed take never leaves an editor running.
try {
	await page.waitForSelector(WARNING, { timeout: 60_000 });
	await page.keyboard.press('Meta+b');
	await pause(2500);
	start = (Date.now() - opened) / 1000;

	// What each finding says, then the two it can fix, then what is left.
	// Top to bottom the underlines are: the model, the choice, the counting question.
	await pause(1500);
	await pointAt(WARNING, 0);
	await pause(3200);
	await pointAt(WARNING, 1);
	await pause(3600);
	await page.mouse.move(900, 600, { steps: 8 });
	await pause(600);
	await quickFix(INFO, 0);
	await quickFix(WARNING, 0);
	await page.keyboard.press('Meta+Shift+m');
	await pause(3500);
	length = (Date.now() - opened) / 1000 - start;
} finally {
	await editor.close();
}

const recording = join(video, readdirSync(video).find((name) => name.endsWith('.webm')));
const output = join(root, 'assets/demo.gif');
// A palette made from this clip. The shared 256-colour one bands on flat syntax colours.
const filter = `fps=8,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(length), '-i', recording, '-vf', filter, output]);
console.log(`record-editor-demo: wrote assets/demo.gif, ${length.toFixed(1)}s`);
