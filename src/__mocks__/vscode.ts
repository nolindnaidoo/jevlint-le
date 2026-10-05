// A stand-in for the editor API, covering only what this extension calls.
// State lives in `_state` so a test can read what the code under test did and
// reset it between cases.

export const _state = {
	config: {} as Record<string, unknown>,
	/**
	 * Settings every test runs under unless it sets its own. Notifications are
	 * at `all` here so a test can read what a command reported. The shipped
	 * default is quieter, and has its own test.
	 */
	suite: { notificationsLevel: 'all' } as Record<string, unknown>,
	diagnostics: new Map<string, unknown[]>(),
	commands: new Map<string, (...args: unknown[]) => unknown>(),
	statusBar: { text: '', tooltip: '', command: '', visible: false },
	messages: [] as string[],
	files: [] as unknown[],
	documents: new Map<string, unknown>(),
	listeners: {} as Record<string, (event: unknown) => unknown>,
	executed: [] as unknown[][],
	activeTextEditor: undefined as unknown,
	textDocuments: [] as unknown[],
	provider: undefined as unknown,
	secrets: new Map<string, string>(),
	input: undefined as string | undefined,
	trusted: true,
	/** What the user clicks in a modal. Undefined is a dismissal. */
	answer: 'Send' as string | undefined,
	modals: [] as string[],
	/** Documents the extension opened to show the user something. */
	shown: [] as string[],
	// The ways the editor can fail. A path with no way to fail here is a path no test has run.
	/** Thrown by every keychain call while set. */
	secretsError: undefined as Error | undefined,
	/** Thrown when the extension opens a document to show the user. */
	showDocumentError: undefined as Error | undefined,
	/** Presses the cancel button of the progress notification now on screen. */
	cancel: undefined as (() => void) | undefined,
	contentProviders: new Map<
		string,
		{ provideTextDocumentContent: (uri: unknown) => string }
	>(),
	/** Buttons offered on warnings, and the one the user presses. */
	buttons: [] as string[],
	press: undefined as string | undefined,
	workspaceFolder: undefined as string | undefined,
	/** Listeners for a settings file being written, added or removed. Call one to say it was. */
	watchers: [] as (() => void)[],
	mcpProviders: new Map<string, { provideMcpServerDefinitions: () => unknown[] }>(),
};

export function _reset(): void {
	_state.config = {};
	_state.suite = { notificationsLevel: 'all' };
	_state.diagnostics.clear();
	_state.commands.clear();
	_state.statusBar = { text: '', tooltip: '', command: '', visible: false };
	_state.messages = [];
	_state.files = [];
	_state.documents.clear();
	_state.listeners = {};
	_state.executed = [];
	_state.activeTextEditor = undefined;
	_state.textDocuments = [];
	_state.provider = undefined;
	_state.secrets.clear();
	_state.input = undefined;
	_state.trusted = true;
	_state.answer = 'Send';
	_state.modals = [];
	_state.shown = [];
	_state.secretsError = undefined;
	_state.showDocumentError = undefined;
	_state.cancel = undefined;
	_state.contentProviders.clear();
	_state.buttons = [];
	_state.press = undefined;
	_state.workspaceFolder = undefined;
	_state.watchers = [];
	_state.mcpProviders.clear();
}

export class Position {
	constructor(
		public line: number,
		public character: number,
	) {}
}

export class Range {
	constructor(
		public start: Position,
		public end: Position,
	) {}
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}

export class Diagnostic {
	code: unknown;
	source: string | undefined;
	constructor(
		public range: Range,
		public message: string,
		public severity: DiagnosticSeverity,
	) {}
}

export class WorkspaceEdit {
	edits: { uri: unknown; range: Range; text: string }[] = [];
	replace(uri: unknown, range: Range, text: string): void {
		this.edits.push({ uri, range, text });
	}
}

const kind = (value: string) => ({
	value,
	append: (part: string) => kind(`${value}.${part}`),
	// A kind contains itself and anything more specific.
	contains: (other: { value: string }) =>
		other.value === value || other.value.startsWith(`${value}.`),
});

export const CodeActionKind = {
	QuickFix: 'quickfix',
	SourceFixAll: kind('source.fixAll'),
};

export class CodeAction {
	edit: WorkspaceEdit | undefined;
	diagnostics: Diagnostic[] | undefined;
	isPreferred: boolean | undefined;
	constructor(
		public title: string,
		public kind: string,
	) {}
}

export enum StatusBarAlignment {
	Left = 1,
	Right = 2,
}

export const Uri = {
	parse: (value: string) => ({
		toString: () => value,
		scheme: value.slice(0, value.indexOf(':')),
		fsPath: value.replace(/^[a-z-]+:\/\//, ''),
	}),
};

const disposable = () => ({ dispose: () => {} });

function listen(name: string) {
	return (handler: (event: unknown) => unknown) => {
		_state.listeners[name] = handler;
		return disposable();
	};
}

export const languages = {
	// Each collection is its own namespace, as in the editor. The linter's is
	// stored under the bare uri, any other under `uri#name`.
	createDiagnosticCollection: (name = 'jevlint-le') => {
		const key = (uri: { toString(): string }) =>
			name === 'jevlint-le' ? uri.toString() : `${uri.toString()}#${name}`;
		return {
			set: (uri: { toString(): string }, items: unknown[]) =>
				_state.diagnostics.set(key(uri), items),
			delete: (uri: { toString(): string }) =>
				_state.diagnostics.delete(key(uri)),
			clear: () => {
				for (const stored of [..._state.diagnostics.keys()]) {
					const own = name === 'jevlint-le' ? !stored.includes('#') : stored.endsWith(`#${name}`);
					if (own) _state.diagnostics.delete(stored);
				}
			},
			dispose: () => {},
		};
	},
	registerCodeActionsProvider: (_selector: unknown, provider: unknown) => {
		_state.provider = provider;
		return disposable();
	},
};

/** What `context.secrets` is in a real editor: the operating system keychain. */
function keychain(): void {
	if (_state.secretsError) throw _state.secretsError;
}

export const _secrets = {
	get: async (name: string) => {
		keychain();
		return _state.secrets.get(name);
	},
	store: async (name: string, value: string) => {
		keychain();
		_state.secrets.set(name, value);
	},
	delete: async (name: string) => {
		keychain();
		_state.secrets.delete(name);
	},
};

export enum ProgressLocation {
	Notification = 15,
}

export const workspace = {
	get isTrusted() {
		return _state.trusted;
	},
	getConfiguration: () => ({
		// What a test set, or else what the suite as a whole runs under.
		get: (key: string) => _state.config[key] ?? _state.suite[key],
	}),
	findFiles: async () => _state.files,
	// Given a uri, the stored document. Given content, a new untitled one.
	openTextDocument: async (target: { toString(): string; content?: string }) =>
		target.content === undefined
			? _state.documents.get(target.toString())
			: { getText: () => target.content },
	// The folder a file belongs to. Undefined is a file opened on its own.
	getWorkspaceFolder: () =>
		_state.workspaceFolder
			? { uri: { fsPath: _state.workspaceFolder } }
			: undefined,
	createFileSystemWatcher: () => {
		const on = () => (listener: () => void) => {
			_state.watchers.push(listener);
			return disposable();
		};
		return {
			onDidChange: on(),
			onDidCreate: on(),
			onDidDelete: on(),
			dispose: () => {},
		};
	},
	registerTextDocumentContentProvider: (
		scheme: string,
		provider: { provideTextDocumentContent: (uri: unknown) => string },
	) => {
		_state.contentProviders.set(scheme, provider);
		return disposable();
	},
	onDidOpenTextDocument: listen('open'),
	onDidChangeTextDocument: listen('change'),
	onDidCloseTextDocument: listen('close'),
	onDidChangeConfiguration: listen('config'),
	get textDocuments() {
		return _state.textDocuments;
	},
};

export const window = {
	createStatusBarItem: () => ({
		set text(value: string) {
			_state.statusBar.text = value;
		},
		set tooltip(value: string) {
			_state.statusBar.tooltip = value;
		},
		set command(value: string) {
			_state.statusBar.command = value;
		},
		show: () => {
			_state.statusBar.visible = true;
		},
		hide: () => {
			_state.statusBar.visible = false;
		},
		dispose: () => {},
	}),
	showInformationMessage: async (
		message: string,
		options?: { modal?: boolean; detail?: string },
	) => {
		if (options?.modal) {
			// The question and the smaller text under it, as the user reads them.
			_state.modals.push(
				options.detail ? `${message}\n${options.detail}` : message,
			);
			return _state.answer;
		}
		_state.messages.push(message);
		return undefined;
	},
	showWarningMessage: async (message: string, button?: string) => {
		_state.messages.push(message);
		if (button) _state.buttons.push(button);
		// The user presses the button offered when a test says so.
		return button !== undefined && _state.press === button ? button : undefined;
	},
	onDidChangeActiveTextEditor: listen('editor'),
	showInputBox: async () => _state.input,
	showTextDocument: async (page: { getText(): string }) => {
		if (_state.showDocumentError) throw _state.showDocumentError;
		_state.shown.push(page.getText());
	},
	withProgress: async (
		_options: unknown,
		task: (progress: unknown, token: unknown) => unknown,
	) =>
		task(
			{ report: () => {} },
			{
				onCancellationRequested: (listener: () => void) => {
					_state.cancel = listener;
					return disposable();
				},
			},
		),
	get activeTextEditor() {
		return _state.activeTextEditor;
	},
};

export class McpStdioServerDefinition {
	constructor(
		public label: string,
		public command: string,
		public args: string[],
		public env: Record<string, string>,
		public version: string,
	) {}
}

type McpProvider = { provideMcpServerDefinitions: () => unknown[] };

/** Agent mode. A test removes the function to stand in for an editor that lacks it. */
export const lm: {
	registerMcpServerDefinitionProvider?: (id: string, provider: McpProvider) => unknown;
} = {
	registerMcpServerDefinitionProvider: (id, provider) => {
		_state.mcpProviders.set(id, provider);
		return disposable();
	},
};

export class EventEmitter<T> {
	private listeners: ((value: T) => void)[] = [];
	event = (listener: (value: T) => void) => {
		this.listeners.push(listener);
		return disposable();
	};
	fire(value: T): void {
		for (const listener of this.listeners) listener(value);
	}
}

export const commands = {
	registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => {
		_state.commands.set(name, handler);
		return disposable();
	},
	executeCommand: async (...args: unknown[]) => {
		_state.executed.push(args);
		if (args[0] !== 'markdown.showPreview') return;
		// The preview renders what the extension serves for that address.
		if (_state.showDocumentError) throw _state.showDocumentError;
		const uri = args[1] as { toString(): string; scheme: string };
		const provider = _state.contentProviders.get(uri.scheme);
		_state.shown.push(provider?.provideTextDocumentContent(uri) ?? '');
	},
};
