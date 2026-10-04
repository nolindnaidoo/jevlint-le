# Public sample

300 questions drawn at random from public code, each read and labeled by hand
for every wording defect, whether or not a rule fired on it. This is the only
measurement here of what the rules miss on real questions.

## How it was drawn

1,411 files from 720 public repositories, found by GitHub code search on
2026-10-04, held 1,655 distinct questions whose instructions were a literal.
They were shuffled with a fixed seed and taken in order, at most three per
repository, until there were 300 from 197 repositories.

## What labels.json holds

One entry per question: the repository, the file path, the question id, its
type, the first 16 hex digits of the SHA-256 of its instructions, and the
labels. The question text is not here, because those files carry their own
licenses. A label is `defects` when the question clearly has the defect a
rule describes, and `borderline` when a careful reader could go either way.
Twelve entries are `skipped`: eleven are not in English and one is a
template slot.

The labels were written before the rules were run over the sample.

## What it showed, on 2026-10-04

Fourteen of the 288 questions that were read had a clear wording defect, about one in
twenty. Thirteen fall under a rule that is on by default.

| | |
|---|---|
| Caught by a default-on rule | 7 of 13 |
| Default-on findings that were wrong | 1 of 8 |
| Rules with no real instance at all | double-negative, generation, negated-noul, numeric-encoding |

The six misses: "Is n odd?", an event ordered "after the most recent repair",
inverted criteria written in Portuguese, two sets of degree levels
("Weak fit, Good fit, Exceptional fit" and "Irrelevant, Minor, Useful,
Important, Critical"), and "unusually broad scope".

Five of the six are fixed. The rules now catch 12 of 13 on this sample, and
that number is not evidence of anything, because the fixes were written
looking at it. The next measurement needs a new sample.
