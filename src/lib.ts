import { fixText } from './lint/fixAll';
import { EXTENSIONS, lintText } from './lint/lint';
import { pageFor, RULE_CODES, RULES } from './lint/rules';

/**
 * What the npm package exports as a library. The editor extension loads this
 * from a project's own `node_modules`, so a project lints with the version
 * it installed. An extension can be older or newer than the copy it loads,
 * which makes every name here a promise: add to it freely, and change or
 * remove nothing without raising `api`.
 */

/** The shape of this module. An editor uses a copy only when it knows this number. */
export const api = 1;

/** The kinds of file this copy reads, as `lint` and `fix` name them. */
export const syntaxes: ReadonlyArray<string> = Object.freeze([
	...new Set(Object.values(EXTENSIONS)),
]);

/** Every rule this copy has, by code: its name, default level, its own page and the vendor page behind it. */
export const rules = Object.freeze(
	Object.fromEntries(
		RULE_CODES.map((code) => [code, { ...RULES[code], page: pageFor(code) }]),
	),
);

/** The findings in a text. Pure: no filesystem and no network. */
export const lint = lintText;

/** The text with every safe fix applied, and how many there were. */
export const fix = fixText;
