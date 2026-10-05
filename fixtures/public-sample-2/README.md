# Public sample 2

300 questions drawn at random from public code on 2026-10-05, each read and
labelled by hand for every wording defect before any rule was run over it.
The first sample was spent when rules were fixed against it. This one has not
been used to change a rule, so its numbers are a measurement.

## How it was drawn

`scripts/draw-public-sample.ts` searched GitHub for files that call Jev,
split by language, and kept those this tool reads. It left out all 197
repositories and every question the first sample used. Of what remained, 900
files were read and 461 distinct questions with literal instructions were
found, in 162 repositories. They were shuffled with a fixed seed and taken in
order, at most three per repository, until there were 300 from 152
repositories.

By type: 155 Noul, 99 Choice, 46 Score. By file: 89 Python, 151 JavaScript
and TypeScript, 31 Go, 17 Rust, 12 JSON.

## What labels.json holds

The same as the first sample: the repository, the path, the question id, its
type, the first 16 hex digits of the SHA-256 of its instructions, and the
labels. The question text is not here, because those files carry their own
licenses. `defects` is a clear case of what a rule describes. `borderline` is
one a careful reader could call either way. Thirteen entries are `skipped`:
twelve are not in English and one is not a question.

The labels were committed on their own, before the commit that added the
scoring, so the order can be checked in the history.

## What it showed

`scripts/score-public-sample.ts` ran every wording rule over the 287
questions that were read. A finding is counted wrong when it fired on a
question with neither a clear nor a borderline label for that rule.

19 of the 287 had a clear wording defect, about one in fifteen.

| | Default-on rules | Every wording rule |
|---|---|---|
| Clear defects under those rules | 8 | 20 |
| Caught | 2 | 9 |
| Findings | 7 | 27 |
| Findings that were wrong | 2 | 14 |

Rule by rule:

| Rule | Default | Clear defects | Caught | Fired | Wrong |
|---|---|---|---|---|---|
| JEV101 double-negative | on | 0 | 0 | 0 | 0 |
| JEV102 arithmetic | on | 6 | 1 | 2 | 0 |
| JEV103 date-comparison | on | 1 | 0 | 0 | 0 |
| JEV104 compound | off | 2 | 1 | 1 | 0 |
| JEV105 generation | on | 0 | 0 | 0 | 0 |
| JEV106 multi-hop | off | 0 | 0 | 2 | 2 |
| JEV107 negated-noul | off | 0 | 0 | 0 | 0 |
| JEV108 inverted-criteria | off | 0 | 0 | 0 | 0 |
| JEV109 multi-dimension-level | off | 0 | 0 | 11 | 10 |
| JEV110 degree-levels | off | 10 | 6 | 6 | 0 |
| JEV111 numeric-encoding | off | 0 | 0 | 0 | 0 |
| JEV112 undefined-boundary | on | 1 | 1 | 5 | 2 |

## What to take from it

- **The default-on rules catch a quarter of what is there.** 2 of 8. The
  first sample's 7 of 13 was the better result, and the 12 of 13 claimed
  after tuning against it does not carry over.
- **`JEV102 arithmetic` is where the misses are.** It caught 1 of 6. The five
  it missed compare quantities without a counting word: "most of the
  technologies", "more HP off them than off me", "runs 40 minutes or longer",
  "under five seconds to live", prices within "ordinary variation".
- **`JEV110 degree-levels` is the most common real defect and is off.** 10 of
  the 19 questions with a defect had it, the rule caught 6 and was wrong on
  none. The four it missed are short scales: "broken, poor, fair, good, like
  new", "Shallow, Medium, Deep", "Poorly, Well", "almost none, some, a lot".
  A rule is on only where a run against Jev showed a cost, so this is a case
  for running that experiment, not for switching it on from these numbers.
- **`JEV109 multi-dimension-level` is rightly off.** 10 of its 11 findings
  were wrong. It fires on a level that lists examples of one quality, such as
  "destructive, security-sensitive, or difficult to reverse".
- **Six rules had no real instance in 287 questions:** `double-negative`,
  `generation`, `multi-hop`, `negated-noul`, `inverted-criteria` and
  `numeric-encoding`. Four of those also had none in the first sample. Nothing here says they are wrong, only that what they look for is
  rare in public code.
- **The labels are one reader's.** A second reader would move some
  borderlines. The counts above are small, so read them as "about a quarter"
  and "most common", not as rates.

No rule was changed because of this sample. The first one that is spends it.
