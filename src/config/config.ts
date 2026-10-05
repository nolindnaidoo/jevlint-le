import * as vscode from 'vscode';
import { DEFAULT_MAX_CALLS, DEFAULT_MODEL } from '../jev/review';
import {
	DEFAULT_FALLBACK_OPTIONS,
	EXTENSIONS,
	MAX_FILE_SIZE_BYTES,
} from '../lint/lint';
import { RULE_CODES } from '../lint/rules';
import type { LintOptions, RuleCode, Severity } from '../types';

export const SECTION = 'jevlint-le';

/** `all` shows every message, `important` hides summaries, `silent` shows only why a command could not run. */
export type NotificationsLevel = 'all' | 'important' | 'silent';

export type Configuration = Readonly<{
	lint: LintOptions;
	include: string;
	exclude: string;
	maxFileSizeBytes: number;
	notificationsLevel: NotificationsLevel;
	jev: Readonly<{
		model: string;
		maxCalls: number;
		sendState: boolean;
		confirm: boolean;
		/** The key as typed into the user's settings. Empty when it is kept elsewhere. */
		apiKey: string;
	}>;
}>;

/** Must equal the defaults declared in package.json. `config.test.ts` holds the two together. */
export const CONFIG_DEFAULTS = Object.freeze({
	rules: Object.freeze({}),
	fallbackOptions: DEFAULT_FALLBACK_OPTIONS,
	ignore: Object.freeze([] as string[]),
	include: `**/*.{${Object.keys(EXTENSIONS).join(',')}}`,
	exclude: '**/{node_modules,dist,out,build,coverage,.git}/**',
	maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
	notificationsLevel: 'important' as NotificationsLevel,
	'jev.model': DEFAULT_MODEL,
	'jev.maxCalls': DEFAULT_MAX_CALLS,
	'jev.sendState': false,
	'jev.confirm': false,
	'jev.apiKey': '',
});

const LEVELS: ReadonlyArray<string> = ['all', 'important', 'silent'];

// An unknown value falls back to the default, which still says when something went wrong.
function readLevel(value: unknown): NotificationsLevel {
	return typeof value === 'string' && LEVELS.includes(value)
		? (value as NotificationsLevel)
		: CONFIG_DEFAULTS.notificationsLevel;
}

function readKey(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

const SEVERITIES: ReadonlySet<string> = new Set([
	'off',
	'hint',
	'info',
	'warning',
	'error',
]);
const CODES: ReadonlySet<string> = new Set(RULE_CODES);

function readStrings(
	value: unknown,
	fallback: ReadonlyArray<string>,
): ReadonlyArray<string> {
	if (!Array.isArray(value)) return fallback;
	return value.filter((item): item is string => typeof item === 'string');
}

function readString(value: unknown, fallback: string): string {
	return typeof value === 'string' && value.trim() ? value : fallback;
}

function readPositive(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

// A typo in settings must not switch a rule off or invent a severity, so an
// entry that is not a known code with a known level is dropped.
function readRules(value: unknown): LintOptions['rules'] {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return CONFIG_DEFAULTS.rules;
	const valid = Object.entries(value).filter(
		([code, level]) =>
			CODES.has(code) && typeof level === 'string' && SEVERITIES.has(level),
	);
	return Object.freeze(Object.fromEntries(valid)) as Partial<
		Record<RuleCode, Severity | 'off'>
	>;
}

export function getConfiguration(): Configuration {
	const settings = vscode.workspace.getConfiguration(SECTION);
	return Object.freeze({
		lint: Object.freeze({
			rules: readRules(settings.get('rules')),
			fallbackOptions: readStrings(
				settings.get('fallbackOptions'),
				CONFIG_DEFAULTS.fallbackOptions,
			),
			ignore: readStrings(settings.get('ignore'), CONFIG_DEFAULTS.ignore),
		}),
		notificationsLevel: readLevel(settings.get('notificationsLevel')),
		include: readString(settings.get('include'), CONFIG_DEFAULTS.include),
		exclude: readString(settings.get('exclude'), CONFIG_DEFAULTS.exclude),
		maxFileSizeBytes: readPositive(
			settings.get('maxFileSizeBytes'),
			CONFIG_DEFAULTS.maxFileSizeBytes,
		),
		jev: Object.freeze({
			model: readString(
				settings.get('jev.model'),
				CONFIG_DEFAULTS['jev.model'],
			),
			maxCalls: readPositive(
				settings.get('jev.maxCalls'),
				CONFIG_DEFAULTS['jev.maxCalls'],
			),
			// Only a literal true turns it on. State is the user's data, and sending it is their call.
			sendState: settings.get('jev.sendState') === true,
			// Off unless asked for: running the command is itself the decision to send.
			confirm: settings.get('jev.confirm') === true,
			apiKey: readKey(settings.get('jev.apiKey')),
		}),
	});
}
