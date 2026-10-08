/**
 * The word lists the wording rules match against. They are heuristics over
 * English text and are scored, not trusted: `corpus.test.ts` records what each
 * rule catches and what it fires on by mistake. Change a list and the scores
 * change with it.
 */

// 'one' is left out on purpose: "more than one place" and "at least one" ask
// whether something exists, which is not arithmetic.
const NUMBER =
	'(?:\\d[\\d,.]*|two|three|four|five|six|seven|eight|nine|ten|a dozen|a hundred|a thousand|half|twice)';

/** An explicit negation. "Neither ... nor" negates once, so `nor` is not counted. */
export const NEGATOR = /\b(?:not|never|no|neither|without|cannot)\b|n't\b/gi;

// Listed, not matched by prefix: "instructions", "independent" and "invent" all
// start like a negative and are nothing of the kind.
const NEGATIVE_WORDS =
	'ineligible|undelivered|unresolved|unable|unavailable|invalid|incorrect|incomplete|unpaid|unsigned|unauthori[sz]ed|unrelated|unclear|inaccurate|impossible|illegal|irrelevant|unsafe|unsatisfied|dissatisfied|unlikely|unaffected|unanswered|unverified|unconfirmed|inactive|inappropriate|insufficient|non-?compliant|unsupported|unused|unlike|untrue|false';

/** A word that carries its own negation, so "not ineligible" negates twice. */
export const NEGATIVE_WORD = new RegExp(`\\b(?:${NEGATIVE_WORDS})\\b`, 'gi');

/** Phrasing where a yes means something is missing. */
const ABSENCE_SOURCE =
	'\\b(?:free (?:of|from)|devoid of|lack(?:s|ed|ing)?|absence of|absent from|without any|fail(?:s|ed)? to|(?:is|are|was|were)\\b[^,;:()]*\\bmissing(?= (?:a|an|the|any|its|their|some)\\b|\\s*\\?|\\s*$)|omit(?:s|ted)?|(?:leaves?|left) out)\\b';
export const ABSENCE = new RegExp(ABSENCE_SOURCE, 'i');

/** Verbs that negate what follows them, so "not fail to" and "not lack" negate twice. */
export const NEGATING_VERB = /\b(?:fail(?:s|ed)? to|lack(?:s|ed)?)\b/gi;

/**
 * A negation sitting directly on a second one: "not ineligible", "never not",
 * "no longer unable", "not fail to". The only form trusted outside a question,
 * where two negations in one sentence are usually two separate instructions.
 */
export const STACKED_NEGATION = new RegExp(
	`(?:\\b(?:not|never|no|cannot)|n't)\\s+(?:(?:longer|left|be|been|yet|so|really)\\s+)?(?:not\\b|never\\b|fail(?:s|ed)? to\\b|lack(?:s|ed)?\\b|(?:${NEGATIVE_WORDS})\\b)`,
	'i',
);

/** A statement that leads with a negative. */
export const LEADS_NEGATIVE = /^\s*(?:no|not|none|nothing|never|nobody)\b/i;

export const ARITHMETIC: ReadonlyArray<RegExp> = Object.freeze([
	/\bhow many\b/i,
	new RegExp(
		`\\b(?:more|fewer|less|greater|higher|lower|larger|smaller) than ${NUMBER}\\b`,
		'i',
	),
	new RegExp(`\\bat (?:least|most) ${NUMBER}\\b`, 'i'),
	// "More than `limit` of the items": the number is a field, and field names are
	// removed before a rule reads, which leaves "more than of".
	/\b(?:more|fewer|less) than\s+of\b/i,
	/\badds? up\b/i,
	new RegExp(`\\b(?:over|under|above|below) ${NUMBER}\\b`, 'i'),
	// Public sample 3: "the number 2 greater than the number 1", "(x > 50)",
	// "40 minutes or longer". Comparisons with no counting word in them.
	/\b(?:more|fewer|less|greater|higher|lower|larger|smaller|bigger) than the (?:number|count|total|sum|amount|limit|threshold|budget|deposit|cap|quota|value)\b/i,
	new RegExp(`\\b${NUMBER} \\w+ or (?:more|longer|less|fewer|shorter)\\b`, 'i'),
	/\b(?:split|divided?|shared?) (?:evenly|equally)\b/i,
	/\b(?:twice|double|triple|half) (?:the|of|as)\b/i,
	/\b(?:divisible by|a multiple of)\b|\b(?:odd|even|prime)\s*\?/i,
	/\bthe (?:number|count|sum|total|average) of\b/i,
]);

/**
 * "(x > 50)", ">= 8.5". Written as a symbol it is arithmetic wherever it sits,
 * so this one is read over the whole instruction and not only the question.
 */
export const COMPARISON_SYMBOL = /[<>]=?\s*\d|\d\s*[<>]=?/;

// What makes "before" a comparison of two times and not a turn of phrase: a
// date-like noun or a finished event after it. "Before trial", "before paying"
// and "after reading the code" order nothing Jev has to work out.
const TIME_ANCHOR =
	'(?:date|deadline|cut-?off|window|period|started|ended|closed|opened|passed|expired|began|finished|arrived|(?:was|were) \\w+ed)';
const UNIT = '(?:minutes?|hours?|days?|weeks?|months?|years?)';

export const DATE_COMPARISON: ReadonlyArray<RegExp> = Object.freeze([
	new RegExp(`\\b(?:before|after)\\b[^.?!,]*\\b${TIME_ANCHOR}\\b`, 'i'),
	/\b(?:prior to|earlier than|later than|sooner than)\b/i,
	// "The latest check after the most recent repair": which of two events came last.
	/\b(?:before|after)\s+the\s+(?:most recent|latest|last|first|previous|earliest)\b/i,
	/\b(?:inside|within|outside)\b[^.?!]*\b(?:window|period|quarter|deadline|term)\b/i,
	new RegExp(`\\b${UNIT} (?:late|early|ago|old|overdue)\\b`, 'i'),
	// "How long a session does the learner want?" asks for a length, not a comparison.
	/\bhow (?:long (?:ago|since|until|before|after)|old|recent)\b/i,
	/\b(?:older|newer|younger|more recent) than\b/i,
]);

/** A Noul that opens like this cannot be answered yes or no. */
export const OPEN_QUESTION =
	/^\s*(?:what|who|whom|whose|where|when|why|which|how much)\b/i;

/** A Noul told to hand something over. A Choice can be told to "name the team" and still pick one. */
export const HAND_OVER = /^\s*(?:name|give|provide|tell)\b/i;

/** An instruction that asks for text to be produced. */
export const GENERATION_VERB =
	/^\s*(?:summari[sz]e|write|list|extract|generate|describe|explain|translate|rewrite|draft|compose)\b/i;

/** Hex colours and literals, and rgb() triples. A six-digit run needs a letter, or `#104000` would be a ticket. */
export const NUMERIC_ENCODING =
	/#(?=[0-9a-f]*[a-f])[0-9a-f]{6}(?:[0-9a-f]{2})?\b|\b0x[0-9a-f]+\b|\brgba?\(/i;

/** Words that grade without describing. A level made only of these gives Jev nothing to match. */
export const DEGREE_WORDS: ReadonlySet<string> = new Set([
	'low',
	'medium',
	'mid',
	'moderate',
	'high',
	'severe',
	'minor',
	'major',
	'mild',
	'weak',
	'average',
	'strong',
	'good',
	'bad',
	'poor',
	'fair',
	'excellent',
	'great',
	'none',
	'some',
	'slight',
	'slightly',
	'somewhat',
	'very',
	'extremely',
	'quite',
	'critical',
	'normal',
	'best',
	'worst',
	'okay',
	'ok',
	'small',
	'big',
	'large',
	'huge',
	'tiny',
	'little',
	'irrelevant',
	'trivial',
	'negligible',
	'useful',
	'important',
	'significant',
	'exceptional',
	'extreme',
]);

/** Words that turn one level into the next without describing either: "not noisy", "noisy", "very noisy". */
export const INTENSIFIERS: ReadonlySet<string> = new Set([
	'not',
	'very',
	'somewhat',
	'slightly',
	'extremely',
	'quite',
	'a',
	'bit',
	'really',
	'fairly',
	'mildly',
	'highly',
	'more',
	'less',
	'most',
	'least',
	'too',
]);

/** "and" followed by one of these starts a second clause, not the second half of a noun pair. */
export const JOINED_CLAUSE =
	/\band (?:is|are|was|were|does|do|did|has|have|had|been|can|could|will|would|should|must|still|also)\b/i;

/** A word that puts what follows inside a phrase: "about billing and shipping" is one topic. */
export const PHRASE_OPENER =
	/\b(?:about|of|for|with|in|on|to|from|between|including|mention\w*|cover\w*|list\w*|describ\w*)\b/i;

/**
 * Words whose line between yes and no is left to the reader: how large is
 * large? Kept to words that are rarely anything but a threshold.
 */
const VAGUE_WORD =
	'(?:large|small|big|often|frequently|rarely|recently|soon|experienced|senior|strong|weak|enough|sufficient(?:ly)?|significant(?:ly)?|substantial(?:ly)?|serious(?:ly)?|severe(?:ly)?|expensive|cheap)';
const INTENSIFIED =
	'(?:very|too|really|quite|fairly|extremely|highly|unusually|especially|overly|excessively) \\w+';
const BE =
	'(?:is|are|was|were|be|been|being|seems?|looks?|appears?|gets?|becomes?|feels?|sounds?)';

/**
 * A vague word where it decides the answer: after a form of "be" ("is the
 * order large"), or closing the question ("come often?"). "Heavy luggage or
 * small children" and "evidence sufficient to decide" describe things on the
 * way to the question and were the rule's wrong findings on public code.
 */
export const VAGUE_PREDICATE = new RegExp(
	`\\b${BE}\\b(?:\\s+\\w+){0,3}\\s+(?:${VAGUE_WORD}|${INTENSIFIED})\\b|\\b(?:${VAGUE_WORD}|${INTENSIFIED})\\s*(?:\\?|$)`,
	'i',
);
