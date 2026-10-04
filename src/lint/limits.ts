/**
 * Every fact about Jev that a rule depends on, with where it was read and
 * when. Rules import from here and hold no vendor number of their own, so a
 * Jev release that moves a limit is a one-file change.
 */
export const VERIFIED_ON = '2026-10-04';

export const LIMITS = Object.freeze({
	/** https://docs.typesafe.ai/api#choice: "a maximum of 255 options per Choice". */
	choiceMaxOptions: 255,
	/** https://docs.typesafe.ai/api#score: "at least two levels; the API accepts up to 10". */
	scoreMinLevels: 2,
	scoreMaxLevels: 10,
});

/** https://docs.typesafe.ai/models: the versioned id both aliases pointed to on `VERIFIED_ON`. */
export const KNOWN_VERSION = 'jev-1.13.0';

/**
 * https://docs.typesafe.ai/models#aliases: an alias "moves when a new release
 * ships, so the answers behind it can change without a change on your side".
 */
export const MODEL_ALIASES: ReadonlySet<string> = new Set([
	'jev-latest',
	'jev-preview',
]);

/** https://docs.typesafe.ai/api#noul: the only documented criteria keys. */
export const NOUL_CRITERIA_KEYS: ReadonlySet<string> = new Set([
	'true',
	'false',
]);

export const DOCS = Object.freeze({
	api: 'https://docs.typesafe.ai/api',
	models: 'https://docs.typesafe.ai/models#aliases',
	choice: 'https://docs.typesafe.ai/primitives/choice',
	scoreLevels: 'https://docs.typesafe.ai/primitives/score#writing-good-levels',
	jaggedness: 'https://docs.typesafe.ai/model-jaggedness/jev-1.13',
	primitives: 'https://docs.typesafe.ai/primitives',
});
