import * as vscode from 'vscode';
import type { Installed } from '../config/installed';
import { type Fixed, fixText } from '../lint/fixAll';
import { lintText, syntaxFor } from '../lint/lint';
import type { LintOptions, LintResult, Syntax } from '../types';
import { ownDocs } from '../ui/diagnostics';
import type { Note } from '../ui/statusBar';
import type { InstalledLookup } from './installedCopies';

/** The library shape this extension knows how to use. See `src/lib.ts`. */
const API = 1;

/** The linter a document is linted with: the copy the extension carries, or the project's own. */
export type Engine = Readonly<{
	lint: (text: string, options: LintOptions, syntax: Syntax) => LintResult;
	fix: (text: string, options: LintOptions, syntax: Syntax) => Fixed;
	/** The docs link for a rule, as this copy knows it. */
	docsFor: (code: string) => string | undefined;
	/** Which copy this is, and why, when that is worth saying. */
	note: Note | undefined;
}>;

export type Engines = Readonly<{
	for: (document: vscode.TextDocument) => Engine;
}>;

type Deps = Readonly<{
	installedFor: InstalledLookup;
	/** Loads a file as a module. Passed in so a test can supply one. */
	load: (path: string) => unknown;
	/** The extension's own version. */
	own: string;
}>;

type Library = Readonly<{
	lint: Engine['lint'];
	fix: Engine['fix'];
	syntaxes: ReadonlyArray<string>;
	rules: Readonly<
		Record<string, { docs?: unknown; page?: unknown } | undefined>
	>;
}>;

function bundled(note?: Note): Engine {
	return { lint: lintText, fix: fixText, docsFor: ownDocs, note };
}

// A module is used only when it is the shape this extension was written for.
function asLibrary(loaded: unknown): Library | undefined {
	const library = loaded as Partial<Library> & { api?: unknown };
	const usable =
		typeof loaded === 'object' &&
		loaded !== null &&
		library.api === API &&
		typeof library.lint === 'function' &&
		typeof library.fix === 'function' &&
		Array.isArray(library.syntaxes) &&
		typeof library.rules === 'object' &&
		library.rules !== null;
	return usable ? (library as Library) : undefined;
}

export function createEngines(deps: Deps): Engines {
	// One load per copy and version. A new version at the same place is a new key.
	const loaded = new Map<string, Library | undefined>();

	const libraryOf = (
		installed: Installed,
		file: string,
	): Library | undefined => {
		const key = `${file}@${installed.version}`;
		if (loaded.has(key)) return loaded.get(key);
		let library: Library | undefined;
		try {
			library = asLibrary(deps.load(file));
		} catch {
			// A copy that will not load is one the editor cannot use, not a reason to stop linting.
			library = undefined;
		}
		loaded.set(key, library);
		return library;
	};

	// The bundled copy, with the reason the project's own is not the one in use.
	const instead = (installed: Installed, why: string): Engine =>
		bundled({
			short: `project has ${installed.version}`,
			detail: `This project installs jevlint-le ${installed.version}, which ${why}. The editor is linting with its own ${deps.own}, so findings here can differ from the project's command line.`,
		});

	return Object.freeze({
		for: (document: vscode.TextDocument): Engine => {
			const installed = deps.installedFor(document);
			// No copy in the project, or the same one the extension carries.
			if (!installed || installed.version === deps.own) return bundled();
			// Loading it runs code from the project, which an untrusted one has not been allowed to do.
			if (!vscode.workspace.isTrusted)
				return instead(installed, 'is not used in an untrusted workspace');
			if (!installed.library)
				return instead(installed, 'is too old for the editor to use');
			const library = libraryOf(installed, installed.library);
			if (!library) return instead(installed, 'the editor could not load');
			if (!library.syntaxes.includes(syntaxFor(document.languageId)))
				return instead(installed, 'does not read this kind of file');
			return {
				lint: library.lint,
				fix: library.fix,
				docsFor: (code) => {
					// A copy from before rule pages has only the vendor page to give.
					const rule = library.rules[code];
					const link = rule?.page ?? rule?.docs;
					return typeof link === 'string' ? link : undefined;
				},
				note: {
					short: `project ${installed.version}`,
					detail: `Linting with this project's own jevlint-le ${installed.version}, as its command line does.`,
				},
			};
		},
	});
}
