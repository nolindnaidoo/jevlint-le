import * as vscode from 'vscode';
import type { Configuration } from '../config/config';
import { ENV_KEY, type Failure } from '../jev/client';
import type { Resolved } from '../services/projectConfigs';
import type { Reviewer, ReviewOutcome, ReviewPlan } from '../services/reviewer';
import { blocked, caution, offer, result } from '../ui/notifier';

/** Where a key can come from. */
export type KeySource = Readonly<{
	getConfiguration: () => Configuration;
	secrets: vscode.SecretStorage;
	/** The environment, passed in so a test can supply one. */
	env: Readonly<Record<string, string | undefined>>;
}>;

type Deps = KeySource &
	Readonly<{
		reviewer: Reviewer;
		lintOptionsFor: (document: vscode.TextDocument) => Resolved;
	}>;

export const JEV_COMMANDS = Object.freeze({
	checkWithJev: 'jevlint-le.checkWithJev',
	setApiKey: 'jevlint-le.setApiKey',
	clearApiKey: 'jevlint-le.clearApiKey',
});

const SECRET = 'jevlint-le.typesafeApiKey';
export const SEND = 'Send';
/** What to do about an untrusted workspace. Saying only that it is one leaves the user stuck. */
const HOW_TO_TRUST =
	" To turn it on, run 'Workspaces: Manage Workspace Trust' and trust this folder.";

export const FAILURES: Readonly<Record<Failure['kind'], string>> =
	Object.freeze({
		key: 'TypeSafe rejected the API key. Set a new one with "JevLint-LE: Set TypeSafe API Key".',
		rejected: 'TypeSafe rejected the request.',
		busy: 'TypeSafe is busy or the rate limit was reached. Try again in a moment.',
		network: 'Could not reach TypeSafe.',
	});

const TRUST = Object.freeze({
	button: 'Manage Workspace Trust',
	command: 'workbench.trust.manage',
});
const SET_KEY = 'Set API Key';

/** Says a paid command is off in an untrusted workspace, with the way to trust it. */
export function refuseUntrusted(what: string): void {
	offer(
		`${what}, so it is disabled in an untrusted workspace.${HOW_TO_TRUST}`,
		TRUST.button,
		TRUST.command,
	);
}

/** Says why there is no key. When none was ever set, offers to set one. */
export function reportNoKey(missing: string): void {
	if (missing !== NO_KEY) {
		blocked(missing);
		return;
	}
	offer(missing, SET_KEY, JEV_COMMANDS.setApiKey);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// What was not sent, said the same way before a run and after it.
function heldBack(plan: ReviewPlan): ReadonlyArray<string> {
	const parts: string[] = [];
	if (plan.unreadable)
		parts.push(`${plan.unreadable} built at runtime and not sent`);
	if (plan.overLimit)
		parts.push(`${plan.overLimit} over the jev.maxCalls limit and not sent`);
	return parts;
}

function describe(outcome: ReviewOutcome, plan: ReviewPlan): string {
	if (outcome.kind === 'failed') {
		const sent = outcome.asked
			? ` after ${plural(outcome.asked, 'request')}`
			: '';
		return `${FAILURES[outcome.failure.kind]} (${outcome.failure.detail})${sent}`;
	}
	// A run the user stopped must not read as one that finished.
	const ran = outcome.cancelled
		? `Cancelled after ${outcome.asked} of ${plural(plan.requests, 'request')}. Jev flagged ${outcome.findings} in what it answered`
		: `Jev answered ${plural(outcome.asked, 'request')} and flagged ${outcome.findings}`;
	const parts = [
		ran,
		`${outcome.inputTokens} input tokens on ${outcome.model || 'no model'}`,
		...heldBack(plan),
	];
	return `${parts.join(', ')}.`;
}

// TypeSafe's published price on the day the checks were calibrated. Shown as "about".
const DOLLARS_PER_MILLION_TOKENS = 0.042;

type Prompt = Readonly<{ message: string; detail: string }>;

// One line to answer and one to read: how much, what it costs, what leaves the machine.
function ask(plan: ReviewPlan): Prompt {
	const cents =
		(plan.inputTokens / 1_000_000) * DOLLARS_PER_MILLION_TOKENS * 100;
	const cost = cents < 1 ? 'under 1¢' : `about ${Math.ceil(cents)}¢`;
	const state = plan.sendsState
		? 'Your state is sent too.'
		: 'Your state is not sent.';
	// "Skipped" already says they were not sent.
	const skipped = heldBack(plan).map((part) =>
		part.replace(' and not sent', ''),
	);
	return {
		message: `Send ${plural(plan.requests, 'request')} to TypeSafe?`,
		detail: [
			`About ${plan.inputTokens.toLocaleString('en-US')} tokens, ${cost}. ${state}`,
			...(skipped.length ? [`Skipped: ${skipped.join(', ')}.`] : []),
		].join('\n'),
	};
}

const LOCKED = `The keychain could not be read. Unlock it and try again, or set ${ENV_KEY} in the environment.`;
const NO_KEY = `No API key. Set one with the button, in Settings under "JevLint-LE: Jev: Api Key", or as ${ENV_KEY} in the environment.`;

/**
 * The key, or the sentence that says why there is none. One typed into the
 * user's settings comes first, because it is the one the user can see. Then
 * the keychain, then the environment. A keychain that cannot be read is not
 * the same as one with no key in it.
 */
export async function findKey(
	deps: KeySource,
): Promise<Readonly<{ key: string } | { missing: string }>> {
	const typed = deps.getConfiguration().jev.apiKey;
	if (typed) return { key: typed };
	const stored = await deps.secrets.get(SECRET).then(
		(key) => ({ key }),
		() => ({ locked: true as const }),
	);
	const key = ('key' in stored && stored.key) || deps.env[ENV_KEY];
	if (key) return { key };
	return { missing: 'locked' in stored ? LOCKED : NO_KEY };
}

async function checkWithJev(deps: Deps): Promise<void> {
	const document = vscode.window.activeTextEditor?.document;
	if (!document) {
		blocked('No file is open.');
		return;
	}
	if (!vscode.workspace.isTrusted) {
		refuseUntrusted(
			'Checking with Jev sends the questions in this file to TypeSafe',
		);
		return;
	}
	const found = await findKey(deps);
	if ('missing' in found) {
		reportNoKey(found.missing);
		return;
	}
	const { key } = found;
	const resolved = deps.lintOptionsFor(document);
	if ('problem' in resolved) {
		blocked(resolved.problem);
		return;
	}
	const lint = resolved.options;
	const plan = deps.reviewer.plan(document, lint);
	if (!plan.requests) {
		const why = heldBack(plan).join(', ');
		result(
			`No Jev questions to check in this file${why ? `: ${why}` : ''}. Nothing was sent.`,
		);
		return;
	}
	const config = deps.getConfiguration();
	if (config.jev.confirm) {
		// A modal settles only when the user answers, so this one is awaited.
		const prompt = ask(plan);
		const answer = await vscode.window.showInformationMessage(
			prompt.message,
			{ modal: true, detail: prompt.detail },
			SEND,
		);
		if (answer !== SEND) return;
	}
	const outcome = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'JevLint-LE: asking Jev about the questions in this file',
			cancellable: true,
		},
		(_progress, token) => {
			const abort = new AbortController();
			token.onCancellationRequested(() => abort.abort());
			return deps.reviewer.review(document, key, abort.signal, lint);
		},
	);
	const message = describe(outcome, plan);
	if (outcome.kind === 'failed') {
		blocked(message);
		return;
	}
	// A run the user stopped is worth saying even to someone who hides summaries.
	if (outcome.cancelled) {
		caution(message);
		return;
	}
	result(message);
}

async function setApiKey(deps: Deps): Promise<void> {
	const entered = await vscode.window.showInputBox({
		title: 'TypeSafe API key',
		prompt:
			'Stored in your operating system keychain by VS Code, not in a settings file.',
		password: true,
		ignoreFocusOut: true,
	});
	const key = entered?.trim();
	if (!key) return;
	const stored = await deps.secrets.store(SECRET, key).then(
		() => true,
		() => false,
	);
	if (!stored) {
		blocked('The key was not stored: the keychain could not be used.');
		return;
	}
	result('API key saved to the keychain.');
}

async function clearApiKey(deps: Deps): Promise<void> {
	const cleared = await deps.secrets.delete(SECRET).then(
		() => true,
		() => false,
	);
	if (!cleared) {
		blocked('The key is unchanged: the keychain could not be used.');
		return;
	}
	result('API key removed from the keychain.');
}

export function registerJevCommands(
	deps: Deps,
): ReadonlyArray<vscode.Disposable> {
	return [
		vscode.commands.registerCommand(JEV_COMMANDS.checkWithJev, () =>
			checkWithJev(deps),
		),
		vscode.commands.registerCommand(JEV_COMMANDS.setApiKey, () =>
			setApiKey(deps),
		),
		vscode.commands.registerCommand(JEV_COMMANDS.clearApiKey, () =>
			clearApiKey(deps),
		),
	];
}
