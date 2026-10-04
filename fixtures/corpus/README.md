# Corpus

Questions the wording rules are scored against, written for this repo.
Nothing here is linted as source: `src/lint/corpus.test.ts` reads
`questions.json`, runs every wording rule over every question, and holds the
result to `scores.json`.

## questions.json

Each entry has an `id`, the `question`, and `defects`: the wording rules that
should fire on it. An empty list means the question is good, one a careful
author would be content to send.

The bad questions include ones the rules are known to miss, on purpose. A
corpus that only held what the patterns already match would report a perfect
score and mean nothing. The good questions include ordinary uses of the words
the rules look for: "and" between two nouns, "before" with nothing after it,
a single negation, a ticket number that looks like a hex colour.

Entries whose id contains `-h` are a second batch, written before a round of
rule changes and scored blind first. Do the same for the next batch: write
it, score it, record the number, and only then change a rule.

When a rule is wrong on a real question, add that question here in your own
words with the right label, then fix the rule.

## scores.json

Generated. Per rule: how many bad questions it caught, how many good ones it
fired on, and the id of every miss and every false firing. Regenerate with
`bunx vitest run src/lint/corpus.test.ts -u` and read the diff before
committing it.
