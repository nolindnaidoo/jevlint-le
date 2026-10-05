# JevLint-LE — specification

**Status: released as 0.1.0 on 2026-10-04.** The exact rules, the wording rules, the
four sources, the VS Code shell and their tests exist and pass. Everything
under an "Extended release" heading is intent and none of it is built.

A VS Code extension in the LE family, category **Check**, that finds the
questions a project sends to TypeSafe's Jev
model and reports the ones written in a way that is documented to produce bad
answers. Linting never calls Jev.

## The one question

**Which Jev questions in this workspace are written in a way known to fail?**

Answered from the text of the question alone, as the user types, with no API
key, no network request and no cost.

## Why this exists

Jev takes a `state` and a map of typed questions (`noul`, `choice`, `score`)
and returns typed answers with probabilities. The output type is guaranteed.
The answer is not. Jev does not report that a question is badly formed. It
returns a confident-looking number either way, and the failure shows up later
as wrong decisions.

## Position

Other tools point Jev at code: they use it to lint, review or triage. This
one checks the questions people write for Jev. What it adds over checking a
request file from the command line is that findings appear in the editor as
you type, read straight out of source code, with no key and no calls.

Checks that need the meaning of a question and not its shape, such as two
options that overlap, cannot be done from text patterns. Those are available
on demand through the **Check This File with Jev** command.

## Scope

**In scope.** Static checks over question definitions and the `model` field
around them.

**Out of scope, permanently.**

- Whether a well-formed question is accurate on the user's data. That needs
  labeled data and API calls, and it is a different product.
- Rewriting a question's wording. The extension names the problem. The user
  writes the fix, except where the fix is mechanical.

## Constraints

- Linting makes no network request and needs no API key. This is an LE family
  extension and that is the family's promise. The one exception is the
  **Check This File with Jev** command, which the user runs on purpose with
  their own key. See "Check with Jev".
- No filesystem writes outside edits the user accepts through a quick fix.
- Refuse rather than guess. A question the reader cannot see whole is reported
  as unreadable and counted, never skipped silently.
- Code follows the LE family standard in `AGENTS.md`.

## Where questions are found

Four readers produce one tree. The first tokenizes JavaScript, TypeScript,
JSON and JSONC and reads object literals, keeping duplicate keys, which
`JSON.parse` would collapse. The second does the same for Python dicts and
SDK calls. Rust and Go share a third, which reads a literal written as a type
and a brace and takes the differences between the two as a dialect. A fourth
reads JSON pasted into a string, in any of them. Every rule, fix and Jev
check runs on the tree and does not know which reader made it.

| | Source | How it is recognized |
|---|---|---|
| **S1** | JSON and JSONC request bodies | An object with a `questions` map where at least one entry has `type` in `noul`, `choice`, `score` and an `instructions` or `criteria` field |
| **S2** | `oxlint-plugin-jev` config | A `jev/ask` rule whose options hold a `rules` array. Each entry with a `question` is a Noul question, identified by its `id` |
| **S3** | JavaScript and TypeScript object literals | The same shape as S1, anywhere in the file, including inside call arguments and callbacks. A question object outside a map is recognized on its own |
| **S5** | Python dict literals | The same shape as S1. `True`, `False` and `None` are read, adjacent and bracketed strings are joined, and an f-string with a slot is unreadable. A dict assigned to a name ending in `questions` is read as a question map |
| **S6** | Python SDK classes | `Noul(...)`, `Choice(...)`, `Score(...)` under a name imported from `typesafe_sdk` or `typesafe_ai`, including `import ... as`. Under any other import, only a call whose arguments are exactly the keywords `instructions` and `criteria` |
| **S7** | Python `system_one(...)` | The first two positional arguments are `state` and `questions`. Keywords are read by name |
| **S8** | Rust | The JSON inside `json!`. A struct or enum variant whose name holds one question type and which has an `instructions` or `criteria` field with a value that could be read. A `::noul(...)`, `::choice(...)` or `::score(...)` call whose first argument is a string, read for its wording only. `Some(x)`, `String::from(x)`, `.to_string()`, `.into()` and `vec![...]` are seen through, and a list of pairs or `BTreeMap::from([...])` is read as a map |
| **S9** | Go | A map with string keys. A struct with a `Type` or `Kind` field, given as a string or as a constant named for the type. A struct named for a question type. Field names are read lowercased. `[]string{...}` is a list |
| **S10** | JSON inside a string | A string that opens with `{` and names `questions`, `instructions` or `criteria`, in any language above. Only a string with no escapes is read, so every position maps back to the file |
| **S4** | SDK helper calls | `noul(...)`, `choice(...)`, `score(...)`, read only for the names the file imports from `@typesafe-ai/sdk`. Method calls, declarations and aliased imports are not read |

A `model` property whose value is a literal alias is found anywhere in the
file, which covers both request bodies and `new TypeSafeClient({ model })`.

### What cannot be read

A value is unreadable when it is not a literal in the file: a variable, a
function call, a template string with a substitution, a shorthand property. An
object or array with a spread, a computed key or a method is partial. Rules
that need an unreadable or partial value do not run. The question gets one
`JEV000` hint, and the unread count is shown beside the findings count. The
count is taken before suppression, so switching `JEV000` off hides the hints
and leaves the count.

## Initial release

Exact checks. Each is true or false from the text, so none can be wrong about
what the text says. `JEV004` is the exception in spirit and is explained below.

### Rules

| Code | Name | Default | Fires when |
|---|---|---|---|
| JEV000 | unreadable | hint | A field a rule needs is built at runtime |
| JEV001 | unpinned-model | warning | `model` is the literal `jev-latest` or `jev-preview` |
| JEV002 | choice-option-limit | error | A Choice has more than 255 options |
| JEV003 | score-level-limit | error | A Score has more than 10 levels |
| JEV004 | no-fallback-option | info | A Choice has two or more options and none is named as a fallback |
| JEV005 | duplicate | error | A question id, a Choice option or a Score level is repeated |
| JEV006 | criteria-shape | error | In a request, a Choice has no map of options or a Score has no array of levels, or a Noul has criteria keys other than `true` and `false` |
| JEV007 | invalid-question | error | The `type` is missing or unknown, or the instructions are an empty string |
| JEV008 | numeric-levels | warning | Every level of a Score is a bare number |
| JEV009 | too-few-options | info | A Choice has fewer than two options, or a Score fewer than two levels |

**JEV001 has no automatic fix.** Pinning needs the current version id, and the
extension cannot fetch it. A hard-coded id would be wrong after the next
release. The message says to copy the `model` value from a response.

**JEV004 is `info`, not `warning`.** TypeSafe's advice is to add `other` or
`none of the above` "when the list might not cover every input", and the text
of a question cannot show whether it does. Measured on 2026-10-04, the rule
fires on 9 of the 11 Choice examples in TypeSafe's own docs. The default
fallback names are `other`, `none`, `none of the above`, `unknown`, `unclear`,
`neither`, `not stated`, `not applicable` and `n/a`, matched case-insensitively
with `_` and `-` read as spaces. The list is a setting.

**Missing instructions are not reported.** The API reference marks
`instructions` required, but the SDK types make it optional and send null, and
public code omits it on Choices whose options carry the meaning.

### What the public questions changed

The exact rules were wrong far more often than their name suggests. On the
first public set 40 of 46 shape and invalid-question findings were false, and
the second set found 23 more. Each cause is fixed and pinned by a test:

- **Local functions named like SDK helpers.** A file's own `noul(...)` wrapper,
  a class method `choice(name)`, an interface signature `score(key): Answer`.
  Helper calls are read only for names the file imports from
  `@typesafe-ai/sdk`, and never for a method call or a declaration.
- **Other clients' field names.** `prompt`, `options`, `legend`, `rubric`,
  `descriptions`. A question carrying one gets no shape finding at all.
- **The Vercel AI SDK's `boolean` type**, which is its name for a Noul.
- **Builders, templates and mocks.** `const q = { type: 'choice', instructions }`
  followed by `q.options = ...`. A missing field is reported only for an entry
  in a `questions` map or an SDK helper call, never for a lone object.
- **Template slots.** `"criteria": "$options"` is a value that arrives later.
- **One option and one level.** Public code sends both where the lists are
  generated, and a public parity suite expects the API to accept them. `JEV009`
  reports both as `info`, and `JEV003` is now only the upper limit.

On the third set, with these in place, the shape rule fired six times in
2,463 questions and all six were real: Nouls with `yes` and `no` criteria, and
Scores sent with no levels.

### Features

- **Diagnostics** inline and in the Problems panel for open JSON, JSONC,
  JavaScript, TypeScript, Python, Rust and Go documents, recomputed 250 ms after an edit. Each
  links to the vendor page behind the rule.
- **Quick fixes**, each offered only where the edit is mechanical and loses
  nothing:
  - `JEV004`: insert a fallback option, matching the quote style, indentation
    and trailing-comma style already there.
  - `JEV001`: pin an alias to the newest version this extension was checked
    against. The title carries the date, because that stops being the newest.
  - `JEV006`: rename `yes` and `no` criteria to `true` and `false`. Turn a
    Score map into an array, keeping every description. Turn a Choice array of
    names into a map.
  - `JEV007`: correct a mistyped type when exactly one real type is within two
    edits.
- **Project settings file.** `jevlint-le.json`, read by the editor, the
  command line and the MCP server. The nearest one to a file applies, looking
  upward as far as the workspace folder in the editor and the working
  directory on the command line. Where one applies it replaces the editor's
  `rules`, `fallbackOptions` and `ignore`, so the editor reports what CI
  would. Merging the two would let them disagree. A file that cannot be used
  stops linting for the files it governs: the editor shows no findings and
  says why in the status bar, and the command line exits 2. A schema
  validates the file as it is written.
- **Quick fixes that silence a finding**: disable its rule for the line or
  for the file, written as a comment in the file's language. Not offered in
  strict JSON, which has no comments, or for JSON pasted into a string, where
  a comment would become part of the JSON.
- **Editor context menu** entries for linting the file, checking it with Jev
  and probing the question at the cursor, shown in the languages the linter
  reads.
- **Status bar** item with the findings count and the unread count for the
  active file. Hidden when the file holds no Jev questions.
- **Commands:** lint the active file, lint the workspace, open settings. The
  workspace command reports files skipped as too large and files it could not
  open.
- **Suppression** by comment: `jevlint-le-disable-next-line JEV004`,
  `jevlint-le-disable-line`, or `jevlint-le-disable` for the file. No code list means
  every rule. JSON has no comments, so the `ignore` setting takes
  `CODE:questionId` entries.
- **JSON schema** for request bodies, applied to files named `*.jev.json`. It
  describes and completes fields and requires `state`, `model` and
  `questions`. It does not validate question types or criteria shapes, because
  the linter reports those with a reason and two reports on one token is noise.
- **Snippets** `jev-noul`, `jev-choice` and `jev-score`. The Choice snippet
  includes a fallback option.

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `jevlint-le.rules` | `{}` | Severity per rule code: `off`, `hint`, `info`, `warning`, `error` |
| `jevlint-le.fallbackOptions` | the list above | Option names that satisfy `JEV004` |
| `jevlint-le.ignore` | `[]` | `CODE:questionId` entries to drop |
| `jevlint-le.include` | JSON, JS and TS globs | Files the workspace command lints |
| `jevlint-le.exclude` | `node_modules`, build output | Files the workspace command skips |
| `jevlint-le.maxFileSizeBytes` | `1000000` | Larger files are reported as skipped |
| `jevlint-le.notificationsLevel` | `important` | How much is said in notifications. `important` hides the summary after a command that worked, and `all` shows it. `silent` also hides notes that a run was cancelled or left files out. Why a command could not run is shown at every level |
| `jevlint-le.jev.model` | `jev-1.13.0` | The model the Jev command asks |
| `jevlint-le.jev.maxCalls` | `25` | The most requests one Jev check may send |
| `jevlint-le.jev.sendState` | `false` | Also send a state written in the file, for `JEV311` and `JEV312` |
| `jevlint-le.jev.confirm` | `false` | Before a paid command sends anything, show what it will send and cost, and wait for a yes |
| `jevlint-le.jev.apiKey` | empty | The TypeSafe key, typed in. User settings only, not synced |

### Not built from the first draft of this spec

- **A size rule.** The limits are 64k tokens per request and 32k for the state
  plus the longest question. Jev's tokenizer is not public, so a character
  bound would be an invented threshold.
- **YAML request bodies.** They need a YAML parser, and no real usage has been
  seen.
- **Localization, the Rust CLI, the MCP server and the npm package.** See
  Extended release 2.

## Wording rules

Built. Text heuristics over the instructions, the criteria and the Score
levels. Unlike the exact rules they can be wrong, so each one is scored and
its default follows from the score. Each maps to a failure mode in TypeSafe's
[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) page
or its primitives guide.

| Code | Name | Default | Fires when |
|---|---|---|---|
| JEV101 | double-negative | info | A question negates twice in one clause, or a negation sits directly on another |
| JEV102 | arithmetic | warning | The question asks Jev to count or compare numbers |
| JEV103 | date-comparison | info | The question asks Jev to order two times or measure the gap between them |
| JEV104 | compound | off | A Noul joins two judgments with 'and' |
| JEV105 | generation | warning | The question asks for a value or for text to be written |
| JEV106 | multi-hop | off | One sentence chains three or more relationships |
| JEV107 | negated-noul | off | A Noul with no criteria is phrased so that yes means something is absent |
| JEV108 | inverted-criteria | off | A Noul's 'true' criterion describes the negative case |
| JEV109 | multi-dimension-level | off | A Score level lists three or more qualities |
| JEV110 | degree-levels | off | Score levels are degree words, or one word turned up and down |
| JEV111 | numeric-encoding | off | The question refers to a value by hex or RGB encoding |
| JEV112 | undefined-boundary | info | A Noul with no criteria turns on a word such as large, often or enough |

A rule that is `off` still runs when switched on in `jevlint-le.rules`.

Text inside backticks or double quotes is left out before a wording rule
reads a question, because it is a field name or quoted data and not the
question's own wording. Structured instructions are read from their
`question` field.

### How a default is earned

A wording rule is on by default only if it catches at least one bad question
and fires on no good one. Misses are recorded and do not block.
`src/lint/corpus.test.ts` enforces this and holds every number to
`fixtures/corpus/scores.json`.

The corpus is `fixtures/corpus/questions.json`: 107 bad questions, each
labeled with the rule that should fire, and 103 good ones. It was written for
this repo in two batches. The second batch was written before the rules were
last changed and scored blind first: the rules then caught 25 of its 47 bad
questions. After the changes they catch 41.

| Rule | Caught | Fired on good |
|---|---|---|
| JEV101 double-negative | 10 of 10 | 0 of 103 |
| JEV102 arithmetic | 10 of 10 | 0 of 103 |
| JEV103 date-comparison | 10 of 10 | 0 of 103 |
| JEV104 compound | 6 of 10 | 0 of 103 |
| JEV105 generation | 11 of 11 | 0 of 103 |
| JEV106 multi-hop | 7 of 9 | 0 of 103 |
| JEV107 negated-noul | 9 of 9 | 0 of 103 |
| JEV108 inverted-criteria | 6 of 9 | 0 of 103 |
| JEV109 multi-dimension-level | 5 of 7 | 1 of 103 |
| JEV110 degree-levels | 9 of 10 | 0 of 103 |
| JEV111 numeric-encoding | 6 of 7 | 0 of 103 |
| JEV112 undefined-boundary | 5 of 5 | 0 of 103 |

### What the labels are worth

The corpus labels are mine. I wrote each bad question to have a defect and
labeled it as I wrote it. Nobody else reviewed them and nothing checked that
Jev answers those questions badly. "Caught 10 of 10" means the rule fired on
ten questions I decided were double negatives.

Two things in the repo go further.

**A hand-labeled sample of real questions.** `fixtures/public-sample/` holds
labels for 300 questions drawn at random from public code, each read for
every defect before any rule was run over it. About one real question in
twenty had a clear wording defect. The default-on rules caught 7 of the 13 and
were wrong on 1 of their 8 findings. Four rules had no real instance at all.
Five of the six misses are now fixed, which makes that sample spent: the next
number needs a new one.

**Experiments to run against Jev.** `fixtures/validation/experiments.json`
pairs a badly written question with the same question written well, over
states whose answer is known. `scripts/validate-defects.ts` sends both and
reports how often each was right. A rule whose bad question does as well as
its good one is reporting a defect that does not exist. It needs
`TYPESAFE_API_KEY`.

It was run once, on 2026-10-04 against `jev-1.13.0`: 122 calls, 37,869 input
tokens, about a sixth of a cent. Results are in
`fixtures/validation/results.json`.

| Rule | Bad question right | Fixed question right |
|---|---|---|
| JEV008 numeric-levels | 3 of 6 | 6 of 6 |
| JEV112 undefined-boundary | 4 of 6 | 6 of 6 |
| JEV004 no-fallback-option | 4 of 8 | 8 of 8 |
| JEV101 double-negative | 6 of 6 | 6 of 6 |
| JEV102 arithmetic | 6 of 6 | 6 of 6 |
| JEV103 date-comparison | 6 of 6 | done in code |
| JEV104 compound | 8 of 8 | 8 of 8 |
| JEV107 negated-noul | 6 of 6 | 6 of 6 |
| JEV108 inverted-criteria | 6 of 6 | 6 of 6 |
| JEV110 degree-levels | 6 of 6 | 6 of 6 |

Three defects cost answers. Seven did not, on these cases, which were few
and easy. So the seven were run again on harder ones.

**The harder run**, same day and model: 174 calls, 62,849 input tokens.
States that take reading, lists of 20 to 40 items with the true count one
either side of the line, dates a day apart in mixed formats. It also records
how sure Jev was of the right answer, from 0 to 1, because two wordings can
both land on the right side of 0.5 with one of them a nudge from flipping.
Results are in `fixtures/validation/results-hard.json`.

The rule for reading the result was fixed before the run: a defect is proven
if the bad question is right at least two times fewer than the fixed one,
advisory if it is right as often but at least 0.10 less sure, and otherwise
has no measured cost.

| Rule | Bad question | Sure | Fixed question | Sure | Outcome |
|---|---|---|---|---|---|
| JEV101 double-negative | 14 of 15 | 0.73 | 15 of 15 | 0.87 | Advisory. Now `info` |
| JEV102 arithmetic | 8 of 12 | 0.58 | 9 of 12 | n/a | Kept. See below |
| JEV103 date-comparison | 12 of 12 | 0.90 | done in code | n/a | No cost on ordering. See the window run below |
| JEV104 compound | 14 of 14 | 0.87 | 14 of 14 | 0.92 | No cost. Stays `off` |
| JEV107 negated-noul | 14 of 14 | 0.86 | 14 of 14 | 0.88 | No cost. Now `off` |
| JEV108 inverted-criteria | 14 of 14 | 0.86 | 14 of 14 | 0.95 | No cost. Now `off` |
| JEV110 degree-levels | 11 of 12 | 0.90 | 11 of 12 | 0.95 | No cost. Now `off` |
| JEV111 numeric-encoding | 12 of 12 | 0.94 | 12 of 12 | 0.97 | No cost. Now `off` |

**Counting did not fit the rule, and is kept.** The bad question was right 8
times in 12 at 0.58 sure, which is close to a guess. That is the defect
TypeSafe describes. But the documented fix, one question per item and a count
in code, was right only 9 times in 12, because with the true count one from
the line a single misjudged item flips the answer. So the defect is real and
the fix is not the cure the docs imply near a threshold.

**`JEV108` missed advisory by 0.01.** It is `off` because the rule was set
beforehand. Jev answers the question and ignores criteria that contradict it,
so inverted criteria are a mistake in what the author wrote down and not one
that changes the answer.

**Numbers, run later the same day**, 24 calls, in `results-numbers.json`.
The answer key was checked in code before anything was sent.

| Rule | Question | Right | Sure |
|---|---|---|---|
| JEV102 | Do three to five amounts add up to more than a limit? | 5 of 12 | 0.52 |
| JEV103 | Was the item returned inside a window counted in days? | 11 of 12 | 0.75 |

Addition is worse than a coin. The window question lost one answer and a
quarter of the certainty that code has, which by the rule above is advisory,
so `JEV103` is back on at `info`. Ordering two dates stays cost-free. What
costs is arithmetic on dates.

**What is and is not proven.** Measured to cost answers: `JEV004`, `JEV008`,
`JEV102`, `JEV112`. Measured to cost confidence: `JEV101`. Everything else on
by default is an exact rule about what the API accepts, plus `JEV105`.

`JEV111` was left out of the harder run by mistake and run on its own
afterwards, 24 calls, with the result in `results-encoding.json`. It compared
"closer to #FF0000 than to #0000FF" with "closer to red than to blue". Those
are the two easiest hex values there are, so a finer comparison might still
fail.

`JEV105` cannot be tested this way. A Noul asked "What is the order number?"
returns a probability, and there is no right or wrong probability for a
question that is not yes or no. The rule reports a mismatch between the
question and the type of answer, the way a type checker does, and needs no
measurement to be true.

The rules that are `off` still describe what TypeSafe documents as failure
modes. On `jev-1.13.0`, with up to fifteen cases each written by one person,
they did not fail. A different model version or harder cases could change
that, and the experiments are there to be rerun.

### What public code showed

The corpus has the same author as the rules, so it is a regression suite and
not evidence. The evidence is three sets of public files found by GitHub code
search, 1,411 files from 720 repositories holding 4,168 questions. They are
not committed, because those files carry their own licenses. Each set was run
once, every wording finding was read, and the rules were fixed before the
next set was collected. The third set was collected after the last round of
fixes.

On the third set, 2,463 questions it had never been run on, the default-on
wording rules fired 23 times. Five were wrong, and all five came from three
causes that are now removed:

- `exceed` used loosely ("exceed what the council may lawfully do"). The bare
  word is no longer an arithmetic pattern.
- "How long a session does the learner want?" read as a date comparison. Only
  "how long ago", "since", "until", "before" and "after" count now.
- `JEV104` fired three times and was right once. It is off again.

Over all three sets with the final rules, the default-on wording rules fire
39 times in 4,168 questions: `JEV112` 17, `JEV102` 11, `JEV110` 8, and one each
for `JEV101`, `JEV103` and `JEV107`. Read by hand, about 34 are right. The
weakest is `JEV112`, where three of 17 turn on a word used as a plain
adjective ("an expensive model"), which is why it is `info`.

**Rules that are off for being wrong on public code.** `JEV104` compound was
wrong on two of three firings in the third set. `JEV106` multi-hop fired six
times across the sets and was never right. `JEV109` multi-dimension-level
fired 166 times, nearly all on levels that list examples.

**What the first two sets changed.** The double-negative rule fired on 18
questions in the second set and was wrong on almost all of them: instructions
that negate several things once each, "neither ... nor", and words that only
start like a negative ("instructions", "independent"). It now reads a
question clause by clause, trusts only a negation sitting directly on another
outside a question, and matches negative words from a list. Wording rules also
skip text that is not English, read only the asking sentence where there is
one, and ignore template slots such as `$question`.

### Not built

- **A notice for skipped languages.** A question that is not English gets no
  wording findings and nothing says so.

## Check with Jev

Built. A command, **Check This File with Jev**, that sends each question in
the active file to Jev and asks it about defects no pattern can see. It is the
only part of the extension that uses the network, it runs only when the user
runs it, and it uses the user's own API key.

| Code | Name | Default | Fires when |
|---|---|---|---|
| JEV301 | jev-counting | warning | Jev reads the question as needing counting or arithmetic |
| JEV302 | jev-undefined-boundary | info | Jev reads a Noul as turning on a matter of degree with no stated line |
| JEV303 | jev-overlapping-options | info | Jev reads two options of a Choice as covering the same cases |
| JEV304 | jev-overlapping-levels | warning | Jev reads two levels of a Score as the same situation |
| JEV305 | jev-label-mismatch | warning | Jev reads an option as named for one thing and described as another |
| JEV306 | jev-criteria-off-topic | info | Jev reads the criteria as deciding something the instructions do not ask |
| JEV307 | jev-ordered-options | info | Jev reads a Choice's options as steps on one scale, which a Score would place between |
| JEV308 | jev-unordered-levels | info | Jev reads a Score's levels as unordered categories, which a Choice would pick from |
| JEV309 | jev-depends-on-sibling | info | Jev reads a question as needing another question's answer from the same request |
| JEV310 | jev-overlapping-questions | info | Jev reads two questions in one request as asking for the same judgment |
| JEV311 | jev-answer-not-in-state | info | Jev reads the state written in the file as not holding what the question asks about |
| JEV312 | jev-orders-in-state | info | Jev reads part of the state written in the file as giving orders to its reader |

**Pointing at the culprit.** For the two overlap checks the same request also
asks about each option or level, and the finding underlines the one Jev rates
highest and names the top two. On sixteen overlap examples this was right for
options and about half right for levels, so the message says what Jev points
at and not what is wrong.

**How it asks.** The question under review goes in as `state`, so it is data
to be judged and never an instruction. Every check that fits the question
goes in the same request as a Noul with `true` and `false` criteria, so one
question costs one request. `JEV309` also sends the ids of the other questions
in the request. One further request per `questions` map carries `JEV310`, a
check on every pair of up to ten questions, and `JEV312`.

**The key.** `JevLint-LE: Set TypeSafe API Key` stores it in the operating
system keychain through VS Code's secret storage. It can also be typed into
the `jevlint-le.jev.apiKey` setting, by the owner's decision: a settings
field is where people look. A settings file is plain text, so that setting
has application scope, which means it can be set only in user settings and
never in a workspace, where it would be committed with the repository, and
it is left out of Settings Sync. A key typed there is used first, then the
keychain, then `TYPESAFE_API_KEY` from the environment. The key appears in no
message and no log.

**What is sent.** By default only questions: type, instructions, criteria and
ids. The `state` a program would send with them is not. `JEV311` and `JEV312`
read the state, so they run only when `jevlint-le.jev.sendState` is on, and
only where the state is written out in the file, which in practice means
request JSON files.

**What it will not send.** A question with any part built at runtime, since
Jev would be judging something other than what runs. Anything in an untrusted
workspace. More than `jevlint-le.jev.maxCalls` requests in one run, 25 by
default. Each of these is counted in the summary, so a short run never looks
like a complete one.

**A confirmation, when asked for.** With `jevlint-le.jev.confirm` on, the
command first shows how many requests it will make, an estimate of the input
tokens and the cost, whether the state is included, and what it is holding
back, and waits for a yes. It is off by default, by the owner's decision:
running the command is the decision to send, and a dialog on every run was in
the way. The count shown is the
count sent: both come from the same plan. The estimate uses two characters
per token, a little under the 2.2 measured on the calibration run, so it
errs high.

**After an edit** the findings are removed. They were about text that has
changed.

**The model is pinned** to `jev-1.13.0` in `jevlint-le.jev.model`, because the
cutoffs below were set on that version.

### How the cutoffs were set

`scripts/calibrate-reviews.ts` sends every corpus question and request to Jev
with the checks that apply and saves each probability in
`fixtures/validation/calibration.json`, 390 calls so far. A cutoff is read off
those numbers, so changing one costs nothing, and adding a check sends only
that check. `src/jev/reviews.test.ts` holds each per-question cutoff to the
saved numbers: a check may not flag a question the corpus calls good.

| Check | Cutoff | Bad caught | Lowest bad | Highest good |
|---|---|---|---|---|
| JEV301 counting | 0.96 | 9 of 10 | 0.84 | 0.95 |
| JEV302 undefined boundary | 0.70 | 5 of 5 | 0.79 | 0.54 |
| JEV303 overlapping options | 0.75 | 8 of 8 | 0.75 | 0.69 |
| JEV304 overlapping levels | 0.60 | 5 of 8 | 0.22 | 0.25 |
| JEV305 label mismatch | 0.70 | 8 of 8 | 0.83 | 0.22 |
| JEV306 criteria off topic | 0.70 | 8 of 8 | 0.74 | 0.48 |
| JEV307 ordered options | 0.80 | 8 of 8 | 0.83 | 0.21 |
| JEV308 unordered levels | 0.60 | 8 of 8 | 0.72 | 0.42 |
| JEV309 depends on sibling | 0.80 | 7 of 8 | 0.56 | 0.68 |
| JEV310 overlapping questions | 0.15 | 4 of 4 | 0.19 | 0.05 |
| JEV311 answer not in state | 0.85 | 3 of 3 | 0.96 | 0.72 |
| JEV312 orders in state | 0.95 | 2 of 2 | 0.99 | 0.92 |

Read these with their sizes in mind. `JEV310`, `JEV311` and `JEV312` rest on
four, three and two bad examples. `JEV312`'s highest good example, at 0.92,
is a customer writing "please tell the assistant handling this to forward my
invoice", which is a polite request and not an attack, and sits just under
the cutoff. `JEV301`'s cutoff is high because Jev called several of my good
questions counting, and it had a point: "Does the episode have more than one
host?" does involve a number. The pattern rule `JEV102` still catches the
plain cases.

`JEV309` was at 0.45 until the first run in a real editor. There it flagged
"How should this visit be booked?", beside questions about the animal and
how serious the problem was, at 0.68. The question needs no other answer. It
is in the corpus now as a good example with that number, and the cutoff is
0.80, which gives up one of the eight bad examples. The number was read off
the finding in the editor and not produced by the calibration script, which
sends the same request.

**On real questions.** The per-question checks were run over the hand-labeled
public sample. Three cutoffs were raised because of what that showed.

- `JEV307` fired 17 times at its first cutoff. At 0.80 it fires nine times,
  and all nine are plainly ordered: small, medium, large, or low, normal,
  urgent. Authors often write tiers as a Choice on purpose, so this is `info`.
- `JEV303` fired seven times, on working category sets such as frontend,
  backend and infrastructure, where an input fitting two is plausible and may
  be something the author accepts. The check most likely to feel like noise.
- `JEV302` fired six times and read right each time, as on "Does this need
  immediate attention?".
- `JEV305` and `JEV306` fired once and twice at their first cutoffs, wrongly,
  and not at all at 0.70. `JEV308` did not fire.

`JEV309` to `JEV312` have not been run on real code: the sample holds single
questions without their requests or their state.

**Whether the defects cost anything.** Four experiments in
`fixtures/validation/overlap.json` and `criteria.json`, 80 calls:

| Check | Bad question | Confidence | Fixed question | Confidence |
|---|---|---|---|---|
| JEV303 overlapping options | 10 of 10 | 0.86 | 10 of 10 | 1.00 |
| JEV304 overlapping levels | 6 of 10 | 0.58 | 9 of 10 | 0.91 |
| JEV305 label mismatch | 9 of 10 | 0.24 | 10 of 10 | 0.95 |
| JEV306 criteria off topic | 10 of 10 | 0.86 | 10 of 10 | 0.98 |

Overlapping levels cost answers. A mismatched label takes Jev's confidence
from 0.95 to 0.24, which is the largest effect measured in this project. The
other two cost confidence only. `JEV307` to `JEV312` are unmeasured and
`info`.

**What this is not.** Jev judging a question is still Jev, with the
weaknesses the rest of this document measures. The cutoffs come from a corpus
its author wrote. A finding from this command is an argument with a number
attached, and the number is shown.

## Python

Built. Public files that call the API split about 50% JavaScript and
TypeScript, 31% Python, 6% Rust, 5% Go and 8% everything else, counted by
GitHub code search on 2026-10-04. The shapes read are S5 to S7 above, taken
from `typesafe-sdk` 0.7.2.

**On public code.** 439 Python files from 353 repositories, at most three per
repository, none seen before the reader was written.

| | |
|---|---|
| Files holding a question | 248 |
| Questions read | 795 |
| Questions with a part built at runtime | 390, about half, the same share as JavaScript |
| Crashes | 0 |
| Findings | `JEV004` 91, `JEV001` 50, `JEV009` 11, `JEV006` 6, `JEV112` 6, `JEV102` 1 |

Every `JEV006`, `JEV009`, `JEV102` and `JEV112` finding was read, with a
sample of the other two. None was wrong about the code in front of it.
Several sit in other projects' test suites, where the mistake is planted on
purpose.

The first run read 725 questions. Two changes made on the strength of it
added 70: wrapper libraries re-export the three classes under their own
module names, and questions built in a loop sit under a key that is an
f-string. Of 1,116 places in those files that look like a question, 783 are
now inside one that was read. The rest sampled as answers, class
definitions, docstrings and prose.

**Not read.** `dict(type="noul", ...)`, a question class called through a
variable, and a `questions` dict passed to a function under another name.

## Command line

It is one npm package, `jevlint-le`, assembled in
`npm/`, that is both the command line and the MCP server. `src/cli/` wraps
`lintText` in a process: it finds
files, lints each with the reader its extension calls for, prints, and sets
an exit status. It imports nothing from the editor and never uses the
network, so the Jev-backed checks and the probe are not in it.

| | Behaviour |
|---|---|
| Paths | A directory is searched for the extensions in `EXTENSIONS`, skipping installed packages, build output and `.git`. No path means the current directory |
| Formats | `text`, one finding per line as `path:line:column`. `json`, with one-based positions, the rule name and its docs link. `github`, workflow annotations |
| Exit status | 0 passed. 1 an error was found, or more warnings than `--max-warnings`. 2 the run could not be done as asked |
| Settings | The `jevlint-le.json` nearest each file. `--config` names one to use for every file instead. `--rule CODE=level`, repeatable, overrides either |
| Standard input | `--stdin-filename` lints piped text under a file name, which picks the reader |

It refuses where passing would mislead. An unknown option is an error and
never a path. A file named outright must be a type it reads. A run that
finds no file to read exits 2, so a CI job pointed at the wrong directory
does not pass. An unknown key in the config file is an error, because a
misspelt `rules` would leave a rule on that its author believes is off. The
summary line always carries the count of questions not read in full.

The help is printed from the table the parser reads, so a flag cannot exist
without its line. `scripts/e2e-cli.js` runs the built bundle as a real
process on `samples/`.

### MCP server

Built. `--mcp` runs the same program as a Model Context Protocol server on
standard input and output, one JSON message per line. An agent that writes a
Jev question can lint it and mend it before a person sees it, which is the
case this tool is most useful for.

| Tool | Input | Returns |
|---|---|---|
| `lint_text` | `text`, an optional `filename` whose extension picks the reader, optional `rules` | The same report as `--format json` |
| `lint_paths` | `paths`, optional `rules` | The same, one entry per file |
| `list_rules` | nothing | Every rule with its default level, its docs link, and whether it runs here |

The extension also offers the server to the editor it runs in, through
`mcpServerDefinitionProviders`, so an agent in VS Code has the tools with no
setup. The command line bundle ships in the VSIX as `dist/cli.js` for this.
An editor without agent mode is left alone.

It is in the same package as the command line and not a package of its own,
which is where this differs from the rest of the family. There the command
line is a Rust crate, so the npm package holds only the server. Here both are
one JavaScript bundle, and two packages would be two versions to keep equal.

A bad argument or an unknown tool is a failed call with the reason in it. Bad
JSON and an unknown method are protocol errors. It answers in the protocol
version the client asked for when it knows it, from `2024-11-05` to
`2025-06-18`. The process test speaks to the built bundle over a real pipe.
It has not been tried in a real agent client.

## Rust and Go

Built. Neither has an SDK from the vendor that this project could confirm, so
there are no standard question classes to recognise. Every project defines
its own types, and the reader works from shape.

**What a project's own types mean.** A struct literal says less than a map.
Its field names are the project's, its question type may live in the type
and not in a field, and how it serialises is not written at the place it is
used. So the reader holds back:

- Criteria held in a named type are not judged. `NoulCriteria { yes, no }`
  drew 58 false shape findings before this.
- A struct with a field the API does not have is the project's own shape, and
  gets no shape finding.
- A struct with no `type` field is never reported as missing one.
- In Rust a struct literal, a pattern and a type definition look alike, so a
  typed question counts only when one of its values could be read.

**On public code.** Files it had not seen, at most three per repository.

| | Rust | Go |
|---|---|---|
| Files, repositories | 442, 305 | 450, 306 |
| Files holding a question | 213 | 185 |
| Questions read | 901 | 732 |
| With a part built at runtime | 233 | 386 |
| Crashes | 0 | 0 |
| `JEV001` unpinned model | 89 | 32 |
| `JEV004` no fallback | 90 | 38 |
| `JEV006` wrong shape | 37 | 23 |
| `JEV009` one option or level | 33 | 23 |

The shape findings that are not plain JSON were each read, 30 in all. After
the changes above none was wrong about the code in front of it. One Go
project scores news with a map of `"0"`, `"3"` and `"5"` where the API wants
a list, which is a real bug the rule found.

Read these numbers with the sample in mind. A large share of the Rust and Go
files are servers that imitate the API and client libraries with their own
test suites, where malformed questions are planted on purpose. The shape
counts say the rules fire where they should. They do not say how often
application code gets it wrong.

**JSON inside a string** changed the JavaScript and Python results by two
questions across 1,850 files, so it matters for Rust and Go and hardly at all
elsewhere.

**Not read.** In Go, a constructor such as `jev.Noul("...")`, because
projects disagree on what the first argument is. In Rust, maps built with
`insert` calls or a `hashmap!` macro. In both, JSON in a string that has
escapes.

## Values built at runtime

About half of the questions in public code have a part that is not written
out where the question is. Every such part in 2,742 public files was sorted
by what kind of code it is.

| Kind | JavaScript | Python | Rust | Go |
|---|---|---|---|---|
| A name passed in, such as a parameter | 32% | 24% | 44% | 58% |
| A member of another value, such as `q.instructions` | 20% | 19% | 6% | 12% |
| A name bound to a literal in the same file | 16% | 20% | 4% | 7% |
| Text with runtime parts in it | 17% | 17% | 6% | 3% |
| A function call | 10% | 13% | 35% | 11% |
| Other | 5% | 7% | 5% | 9% |

Two of these are read now.

**A name bound to a literal** is followed to it, and so is a member of one,
`TEXT.late.ask`. A finding is reported where the literal is written. The
reader does not know scopes, so it follows a name only when the file binds
it exactly once, it is not a parameter anywhere in the file, and nothing
assigns into it or calls a method that changes it. An empty container is
never followed: it is a starting point for something built later. Each of
those conditions was added after a false finding on public code. The first
run reported 71 single-option findings, all on containers filled after they
were written.

**Text with runtime parts** keeps its fixed text, with a placeholder where
each runtime part goes: template literals, f-strings, `str.format`,
`format!`, `Sprintf`, and strings joined with `+`. The rules that the fixed
text can answer run on it. `JEV112` does not, because a slot may be where
the line is stated. The question is still counted as not fully read, and Jev
is never shown it.

**What it changed.** Across those files 187 "cannot read" hints went away
and 114 unpinned models and 35 missing fallback options were found that
were hidden behind a name. Reading fixed text added one wording finding.

| Not fully read | Before | After |
|---|---|---|
| JavaScript and TypeScript | 58% | 54% |
| Python | 49% | 39% |
| Rust | 26% | 27% |
| Go | 53% | 51% |

The share moved little, and the table above says why. The largest group is
a name passed in, and most of those are wrapper functions: `function
ask(instructions, criteria)` returning a question built from its
parameters. That object is not a question. The question is at each place
the function is called.

### Wrapper functions

Built. A function defined in the file that builds one question from its
parameters is a wrapper. Each call to it is read as the question that call
builds, with every parameter replaced by what the call passes. A finding is
reported on the argument, where the text is written, and a fix edits it
there.

The wrapper itself draws no hint any more: it holds no question. A part the
wrapper computes from a parameter, such as `dict.fromkeys(options)`, stays
unread at each call, and so does a part the call computes or leaves out.

It reads a call only when the name can mean one thing: defined once in the
file, not a method, building exactly one question. A call that only hands on
names it was given is another wrapper and is not read.

Across the same public files this found 271 more questions than before and
removed 595 hints, against 310 new ones on calls that pass something
computed. It found 77 missing fallback options, 14 counting and date
questions, and a handful of shape mistakes that were invisible before.

| Not fully read | At first | With names and templates | With wrapper calls |
|---|---|---|---|
| JavaScript and TypeScript | 58% | 54% | 45% |
| Python | 49% | 39% | 39% |
| Rust | 26% | 27% | 23% |
| Go | 53% | 51% | 39% |

Of the JavaScript questions still not fully read, about a third have their
fixed text checked and about a third take their wording from a value passed
in from another file or a loop.

**Not read.** A wrapper defined in another file. A wrapper that is a method.
Questions built in a loop over a table of data.

### Loops over a table: measured, not built

A loop such as `for (const c of CHECKS)` that builds a question from each row
looked like the next thing to read. It was counted before any code was
written, under the rules that would keep it safe: a plain loop, over a table
written in the same file and never changed, using the row's fields directly.

| | JavaScript | Python | Go | Rust |
|---|---|---|---|---|
| Wording is a field of another value | 218 | 99 | 47 | 10 |
| In a plain loop | 130 | 38 | 22 | 3 |
| Table is written in the same file | 11 | 8 | 2 | 1 |
| Rows whose text could be read | 39 | 0 | 0 | 3 |

About 42 questions in 3 files, out of roughly 6,000. In 100 of the 130
JavaScript loops the table is a parameter of the function the loop is in, so
the code is a general helper and the data is in another file or arrives at
runtime. The loop is not the barrier. Reading across files is, and that
would need its own count first.

## Probe a question

Built. **Probe the Jev Question at the Cursor** sends one real question
against the real state written beside it, several times, and reports whether
the answer depends on how the question is laid out.

| Variant | Applies to | What changes |
|---|---|---|
| as written, three times | every question | Nothing. Shows how far the number moves on its own |
| options reversed | Choice | The same options in the opposite order. TypeSafe documents a lean toward the first |
| names hidden | Choice with every option described | Each name replaced by a blank one, read back by position |
| levels reversed | Score | The same levels in the opposite order, read back flipped |
| criteria removed | Noul with criteria | The instructions alone |

Every change is mechanical. Nothing rewrites the wording, because a reworded
question changes the meaning along with the layout, and a moved answer could
then be blamed on either.

The report opens as a Markdown page: a verdict, the spread across the three
identical requests, and one row per request. If identical requests disagree
it says the answer is too close to call and blames no layout.

It needs the state as a literal in the file, so it works on request JSON files
and on code that writes the state inline. It sends that state without the
`jev.sendState` setting, because a probe is a test against the real input.
It asks first only when `jev.confirm` is on. Five or six requests per probe.

Tried once against `jev-1.13.0` on a parcel that was both late and damaged:
the answer held at "damaged" through every variant with confidence between
0.59 and 0.66.

## Roadmap

Status: on hold since 2026-10-04, by the owner's decision. The site listing
and the 0.1.0 release are done. Nothing else below is started, and each item
waits on a go-ahead.

### More languages

No tool lints Jev questions in any of these. Counts are public files that
call the API, from GitHub code search on 2026-10-04.

| Language | Files | How it would be read |
|---|---|---|
| Swift | 213 | A dialect of the reader Rust and Go share |
| C# | 182 | The same |
| Java | 155 | The same |
| Kotlin | 88 | The same |
| PHP | 132 | A second shared reader, for maps written with `=>` |
| Ruby | 93 | The same |
| Elixir | 77 | The same |
| Shell | 155 | No reader. The JSON-in-strings reader, pointed at shell files, for requests pasted into `curl` |

Together about 8% of public Jev code. Three of them have under 100 public
files, so the run over public code that every language so far has had will
be thin for those.

### Other editors, through the command line

A reader added once serves both the VS Code extension and the command line.
Separate extensions for Xcode, the JetBrains editors and Visual Studio are
not planned: each is its own product, in its own language, for a small
audience. Those editors show the output of a command run at build time or on
save, so the command line reaches them.

- **An output format per editor that needs one.** Xcode shows a line of the
  form `File.swift:12:5: warning: message` inline. This is how the usual
  Swift linter works. Not checked against a current Xcode.
- **A Swift Package build plugin**, so a package can run the lint on every
  build without a hand-written build step.

Findings then appear at build time in those editors, and as you type only in
VS Code.

### Reading across files

The one barrier left to reading more questions: a wrapper, a constant or a
table defined in one file and used in another. It is a larger change than
anything built so far, because the reader takes one file at a time. Count
how many questions it would recover before building it, as was done for
loops.

### The LE Tools site

Done on 2026-10-04, in `letools-site`. This is the one roadmap item that is
not on hold. The site carries this tool and allows a tool that differs from
the other sixteen.

- **A featured section ahead of the other extensions**, with this tool in it,
  and the tool also listed among the rest in its right place.
- **The site's claims are read per tool.** Its registry and its copy stated
  things of every tool, such as twelve locales and a Rust crate, that are not
  true of this one. The registry now declares what this tool has: one npm
  package for the command line and the MCP server, its Open VSX namespace, no
  MCP registry listing, and that one command sends on request.
- **The fleet check names it and does not compare it.** `OUTSIDE_FLEET` in the
  site's `scripts/check-fleet.ts` lists this repo, and a test there holds every
  tool in exactly one list. The files this repo copies unchanged, listed in
  AGENTS.md, are still kept equal by hand.

### Publishing

Released as 0.1.0 on 2026-10-04, from the `Release` workflow: the VS Code
Marketplace, Open VSX and npm. The repository is public.

On Open VSX it is published under the `nolindnaidoo` namespace, which is the
manifest's publisher. The rest of the family is under `OffensiveEdge` there
until they are moved, so this tool sits apart from them on that registry for
now. The owner claimed the `nolindnaidoo` namespace on 2026-10-04 and Open VSX
granted it, so the listing is verified. The family is to follow it there.

Not planned for now: a Rust port of the command line, which every sibling
has. The TypeScript one lints thousands of files in seconds, and a port would
be every reader and rule kept in agreement twice. Nor a listing in the MCP
registry. The npm package it would sit on is published, so it waits only on
a go-ahead.

## Extended release 1: request-level rules

| Code | Name | Fires when | Notes |
|---|---|---|---|
| JEV201 | batchable | Two or more calls in one function pass the same `state` expression | Vendor cookbook: one call with 13 questions was 12.2x cheaper and 10.0x faster |
| JEV202 | ungated-answer | A Choice or Score answer is used and `confidence` is never read | Needs data flow. Highest false-positive risk in this spec |
| JEV203 | large-state | A literal state exceeds a size bound | "Large state full of irrelevant detail". Bound is proposed |
| JEV204 | option-order | A Choice whose options were never tested in another order | Vendor: Jev leans toward the first option. Cannot be checked statically. Listed so it is not forgotten |

More sources: the Vercel AI SDK's `experimental_evaluate`.

## Extended release 2: surfaces

- **Question inventory.** A tree view of every question in the workspace with
  type, model and findings.
- **Rust CLI** in `crate/`, following the family pattern: the lint ported, an
  ignore-aware tree walk, and a shared fixture corpus with a parity check
  against the extension. The command line in `src/cli/` already gives CI an
  exit code, so this is about the family pattern and not a missing feature.
- **MCP registry listing.** The npm package it needs is published.
- **Localization** into the family's 12 locales.

## Verification

### What was verified, and how

Read from the raw documentation pages on 2026-10-04, not through a summarizer:

- Request and response shape, the three question types and their `criteria`
  shapes, and that Noul `criteria` is optional:
  `docs.typesafe.ai/api`.
- 255 options and 2 to 10 levels: the same page.
- The aliases `jev-latest` and `jev-preview`, and the vendor's own advice to
  pin a versioned id once thresholds are tuned: `docs.typesafe.ai/models`.
- The fallback advice and the bare-number levels example (score 0.55 at
  confidence 0.33 with numeric levels, 0.0 at confidence 1.0 with described
  ones): `docs.typesafe.ai/primitives/choice` and `/primitives/score`.
- Helper signatures `noul(instructions?, criteria?)`,
  `choice(instructions, criteria)`, `score(instructions, criteria)`:
  `typesafe-ai/typesafe-sdk-js` at `v0.6.0`, `src/questions.ts`.
- The `oxlint-plugin-jev` rule shape: its README.

Measured on 2026-10-04 against the 14 embedded TypeScript examples in
TypeSafe's docs pages: 28 of 28 questions found, none unreadable, no rule other
than `JEV004` fired.

### What failing on purpose found

The stand-in for the editor that the unit tests run against could not fail:
a progress notification could not be cancelled, the keychain always worked,
and a page always opened. It was given a way to fail in each, and a test was
written for what should happen. Ten tests failed. Five defects were behind
them:

- A Jev check the user cancelled reported its partial result as the whole.
- A request cut off by that cancel was reported as "Could not reach TypeSafe".
- A cancelled probe opened a report built from some of its requests.
- A probe whose report page could not be opened lost the result, after the
  requests had been paid for.
- A keychain that could not be read or written threw, and the environment key
  was not tried.

Each is fixed, and each test was seen to fail before its fix.

### Not verified

- **Where `oxlint-plugin-jev` reads its `model` setting.** The README lists the
  setting and does not show its place in the config. `JEV001` therefore fires
  on an alias written anywhere in the file and never on an absent `model`.
- **What the API does with Noul criteria keys other than `true` and `false`.**
  `JEV006` reports them as undocumented.
- **The rendered UI.** The extension runs in a real VS Code under test, both
  from source and as an installed VSIX, and the tests read its diagnostics
  through the API. Nobody has looked at the status bar, the squiggles or the
  hover on screen.
- **Open VSX and Marketplace name search beyond the first page of results.**

## Guarding against drift

- **Vendor facts live in `src/lint/limits.ts`** with the source URL and the
  date read. Rules import from it and hold no vendor number of their own.
- **Rule tables and the registry must agree.** `src/lint/rules.test.ts` fails
  when the code, name or default severity in this document or the README
  differs from `src/lint/rules.ts`.
- **Declared settings and code defaults must agree**, and every declared
  command must be registered. `src/extension.test.ts` holds both.

## Risks

- **R1. Vendor change.** Jev is three weeks old and closed. Limits, field
  names and failure modes can change in any release. The jaggedness page is
  written per model version, so wording rules will need a version dimension.
- **R2. Vendor ships validation.** TypeSafe could add question validation to
  the API or SDK. The SDK already throws on a Choice given an array.
- **R3. Name.** Decided 2026-10-04: `jevlint-le`, in the LE family. "Jev" is
  TypeSafe's product name and its trademark policy has not been checked.
  `jevlint` alone is taken on GitHub and PyPI by tools that are not this one.
- **R4. Small audience.** API access is gated, so the number of people writing
  Jev questions today is unknown.

## Open questions

- **Q2.** Should the lint target typed-decision requests in general?
  Cloudflare and OpenRouter reportedly accept the same request shape.
- **Q3.** What false-positive rate lets a wording rule ship on by default?

## Sources

- https://docs.typesafe.ai/api
- https://docs.typesafe.ai/models
- https://docs.typesafe.ai/primitives
- https://docs.typesafe.ai/model-jaggedness/jev-1.13
- https://github.com/typesafe-ai/typesafe-sdk-js
- https://github.com/wobsoriano/oxlint-plugin-jev
