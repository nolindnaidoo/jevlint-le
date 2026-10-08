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

Not yet scored.
