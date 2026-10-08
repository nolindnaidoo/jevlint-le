# Public sample 3

276 questions drawn at random from public code on 2026-10-08, each read and
labelled by hand before any rule was run over it. The first two samples are
spent: rules were fixed against the first, and the second is the target for
the changes that follow this one.

## How it was drawn

`scripts/draw-public-sample.ts --seed 3` searched GitHub for files that call
Jev, split by language, and kept those this tool reads. It left out all 349
repositories and every question the first two samples used. Of what
remained, 900 files were read and 362 distinct questions with literal
instructions were found, in 133 repositories. They were shuffled with a
fixed seed and taken in order, at most three per repository. That gave 276,
short of the 300 asked for: the pool of public Jev code no sample has used is
running down.

By type: 143 Noul, 94 Choice, 39 Score. By file: 75 Python, 123 JavaScript
and TypeScript, 28 Go, 47 Rust, 3 JSON.

## What labels.json holds

The same as the earlier samples: the repository, the path, the question id,
its type, the first 16 hex digits of the SHA-256 of its instructions, and the
labels. The question text is not here, because those files carry their own
licenses. `defects` is a clear case of what a rule describes. `borderline` is
one a careful reader could call either way. 24 entries are `skipped`: 20 are
not in English and 4 are not questions (an empty string, a key, and two
probe markers).

Two codes here name rules that did not exist when the labels were written.
They were labelled so the rules could be measured the day they were built:

- `JEV011`: a description that only repeats its name. `"low": "low"`,
  `"success": "Successful"`, or a Noul whose criteria are `y` and `n`.
- `JEV012`: instructions that do not say what is being asked. `p`, `Rate`,
  `Which?`, `done`, `y?`. The rule's threshold is read off these labels, so
  this sample does not measure `JEV012`; the next one does.

The labels were committed on their own, before the commit that added the
scoring, so the order can be checked in the history.

## What it showed

`scripts/score-public-sample.ts` ran every wording rule over the 252
questions that were read, with the rules as they stood on 2026-10-08, before
any was changed. A finding is counted wrong when it fired on a question with
neither a clear nor a borderline label for that rule.

35 of the 252 had a clear defect, 41 defects between them. 28 of the 35 had
one no rule looked for, `JEV011` or `JEV012`, and 27 had nothing else wrong.
The wording rules had 8 clear cases between them.

| | Default-on rules | Every wording rule |
|---|---|---|
| Clear defects under those rules | 3 | 8 |
| Caught | 1 | 4 |
| Findings | 4 | 19 |
| Findings that were wrong | 2 | 14 |

Rule by rule, leaving out the six that had no clear case and no finding:

| Rule | Default | Clear defects | Caught | Fired | Wrong |
|---|---|---|---|---|---|
| JEV102 arithmetic | on | 3 | 1 | 2 | 0 |
| JEV104 compound | off | 0 | 0 | 1 | 1 |
| JEV106 multi-hop | off | 0 | 0 | 1 | 1 |
| JEV109 multi-dimension-level | off | 0 | 0 | 10 | 10 |
| JEV110 degree-levels | off | 5 | 3 | 3 | 0 |
| JEV112 undefined-boundary | on | 0 | 0 | 2 | 2 |

Not measured by a rule, because none existed:

| Label | Clear | Borderline |
|---|---|---|
| JEV011 description repeats its name | 10 | 2 |
| JEV012 instructions do not say what is asked | 23 | 7 |

## After the changes

The same labels, scored again once 0.4.0's rule changes were made. This run
is a check, not a measurement: `JEV102`, `JEV110` and `JEV112` were changed
with these misses in view, and `JEV012`'s threshold came from these labels.

| | Default-on rules |
|---|---|
| Clear defects under those rules | 41 |
| Caught | 36 |
| Findings | 40 |
| On a borderline label | 4 |
| Findings that were wrong | 0 |

| Rule | Default | Clear defects | Caught | Fired | Borderline | Wrong |
|---|---|---|---|---|---|---|
| JEV011 description-repeats-name | on | 10 | 8 | 8 | 0 | 0 |
| JEV012 terse-instructions | on | 23 | 20 | 21 | 1 | 0 |
| JEV102 arithmetic | on | 3 | 3 | 4 | 1 | 0 |
| JEV110 degree-levels | on | 5 | 5 | 7 | 2 | 0 |
| JEV112 undefined-boundary | on | 0 | 0 | 0 | 0 | 0 |

`JEV011` misses "success: Successful", a different word from the key, and a
Noul whose criteria are a Choice's, which `JEV006` reports instead. `JEV012`
misses "Rate the level.", three words, and "how much?" and "how relevant",
which open with a question word and so are left alone with "How severe?".

## The checks that ask Jev

`reviews.json` holds, by hash, the probability Jev returned for every
per-question check, `JEV301` to `JEV308`, on each of the 252 questions read:
252 calls on 2026-10-08, `jev-1.13.0`. The firings at the cutoffs then in
force were read by hand and are summarised in SPEC.md under "What public
sample 3 showed". None was wrong and no cutoff moved.

## What to take from it

- **The defects in public code are structural, not wording.** 28 of the 35
  have a description that says nothing or instructions that say nothing, and
  27 have nothing else wrong. Most are in test and demo code.
- **`JEV102` misses comparisons written with symbols or plain words.**
  "Is the number 2 greater than the number 1?" and "(x > 50) ... (>= 8.5)".
  The one it caught had a counting word.
- **`JEV112` was wrong both times it fired**, on "heavy luggage" and
  "evidence sufficient to evaluate", where the degree word sits on a noun or
  is bounded by the clause after it. The same cause as its wrong findings on
  sample 2.
- **`JEV110` is right every time it fires, again**, and misses levels that
  carry an intensifier or a gloss: "Very casual / slang", "Slightly
  complex", "Moderate". 0 wrong in 9 firings across two samples.
- **`JEV109` and `JEV106` are wrong every time**, on this sample as on the
  last two.
- **The labels are one reader's.** The counts are small, so read them as
  "nearly all" and "every time", not as rates.
