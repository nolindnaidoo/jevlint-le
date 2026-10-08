# Changelog

## 0.5.0 — 2026-10-08

OpenAI's Decisions API, `gpt-6-luna`, is read and checked the way Jev is.

- **A Decisions request is linted.** The `predicate`, `choices` and
  `levels` shape, in a request body, in `client.decisions.create(...)` in
  TypeScript and Python, and in the Vercel AI SDK's `decide()` for either
  vendor. Every rule with evidence behind it fires on a Luna question as on
  a Jev one, with Luna named in the message. Before this a Decisions request
  was read as a foreign shape and reported clean.
- **Held back on a Luna question**: the two TypeSafe limit rules, since
  OpenAI publishes none, and the model-alias rule, since there is no alias.
- **Shape mistakes in OpenAI's own words.** `choices` written as a map or as
  bare names, a Choice with no `choices`, a Score with no `levels`, and a
  mistyped `predicate`, which is fixed on the lightbulb. The fallback option
  is added as a `{ value, description }` entry.
- **Check with Luna.** `--jev-model gpt-6-luna` on the command line, or
  `jevlint-le.jev.model` in the editor, sends the same checks to OpenAI's
  Decisions API with the key in `OPENAI_API_KEY`, in the keychain through
  **Set OpenAI API Key**, or in `jevlint-le.jev.openaiApiKey`. The cutoffs
  were set on `jev-1.13.0`, and every finding from Luna says so. The probe
  asks Jev only. **Clear API Keys** now clears both.
- **A Score with one degree word beside one described level was flagged as
  a ladder.** `["Low", "Nobody can log in"]` no longer is.
- **The MCP server tells an agent it reads both vendors.** Its tool
  descriptions and its `instructions` name Jev, OpenAI's Decisions API and
  the AI SDK's `decide()`, so an agent writing a Decisions request knows to
  lint it. The tools themselves already read every shape.
- The GitHub Action and the pre-commit hook pin 0.5.0.

## 0.4.0 — 2026-10-08

Fewer rules, every one measured. A third sample of public Jev questions,
labelled before any rule ran, showed that nearly every real defect is an
option described as its own name or instructions of a word or two, and that
the wording rules were right or wrong in the same places as on the two
samples before. The rules now follow that.

- **`JEV011 description-repeats-name`**, new, informational. An option whose
  description is its name again (`"a": "A"`, `"billing": "Billing"`), or a
  Noul whose criteria say yes and no. Jev matches the state against the
  description, and these add nothing to the name. Measured: where the name
  already says something, no cost; the cost is in names that say nothing,
  which is what every public case was.
- **`JEV012 terse-instructions`**, new, informational. Instructions of one or
  two words (`Rate`, `Which?`, `Pick one.`) that lean on the question id,
  which Jev never sees. Measured: "Refund?" was right 9 of 12 times at 0.70
  sure, against 10 of 12 at 0.85 for the question written out. A two-word
  question that opens with how, who, what, which, where, when or why is left
  alone.
- **`JEV110 degree-levels` is on**, as a warning. Measured: Shallow, Medium,
  Deep placed 4 of 12 code reviews right, against 12 of 12 for levels that
  describe what each looks like. It was also the most common real defect in
  two samples and right every time it fired. It now catches levels that are
  a bare word or two (`Shallow`, `Like new`, `Almost none`) and levels with a
  gloss after a slash (`Very casual / slang`).
- **The checks that ask Jev were scored on real questions for the first
  time**: 252 public questions through `JEV301` to `JEV308`. 27 findings,
  every one read, none wrong. No cutoff moved. The probabilities are in
  `fixtures/public-sample-3/reviews.json`.
- **`JEV004 no-fallback-option` says what a missing fallback costs**, which
  is the largest cost measured anywhere: in our run Jev answered every input
  that fit no option wrong, and an independent audit found 95% abstention
  with an "unknown" option against 0% accuracy without one. It stays `info`,
  because text cannot tell an exhaustive set of options from one that is
  not, and it fires on most Choices in public code. More names count as a
  fallback: `uncertain`, `unsure`, `ambiguous`, `undetermined`,
  `insufficient_evidence`, `cannot_tell`, and "other" in five more
  languages, and a name counts when it is a word in the option's name, so
  `none_implied` and `other_or_unclear` count.
- **`criteria: { "options": [...] }` is reported as the mistake it is.** The
  API accepts that as a one-option Choice that answers `options` every time
  at full confidence. `JEV006` now says so, as an error, with a fix on the
  lightbulb that is never applied unasked, since the API does not refuse it.
- **`JEV102 arithmetic` reads comparisons with no counting word**: `x > 50`,
  "greater than the number", "40 minutes or longer", "under five seconds".
  It caught 1 of 3 on the sample before and 3 of 3 after.
- **`JEV112 undefined-boundary` fires only where the vague word decides the
  answer**: after a form of "be", or closing the question. Every wrong
  finding it had on public code was an adjective on a noun, "heavy luggage"
  or "an expensive model". It now has none.
- **`JEV106 multi-hop` and `JEV109 multi-dimension-level` are removed.**
  Wrong on every firing across three samples. A settings file or `--rule`
  that names either is refused, as for any rule that does not exist.
- **A second gate on defaults.** A wording rule stays on only while it is
  right on at least 9 of 10 of its findings on a public sample it was not
  tuned against. The samples and their labels are in `fixtures/`.
- The GitHub Action and the pre-commit hook pin 0.4.0.

## 0.3.0 — 2026-10-08

- **The editor lints with the copy a project installs.** Add `jevlint-le` to
  a project's dev dependencies and the extension uses that copy, for findings
  and for fix on save, so the editor and the project's command line report
  the same things and the version changes only when `package.json` does. The
  status bar says which copy is in use.
- **With none installed, nothing changes.** The extension lints with the copy
  it carries, with no setup, as before.
- **It falls back to its own copy and says why** when the project's copy
  cannot be used: the workspace is not trusted, the copy is older than 0.3.0,
  it does not load, or it does not read that kind of file. The status bar
  names the project's version, since findings can then differ from CI.
- **Lint Workspace reads files from disk** and opens none of them. A run over
  a large project used to leave every file it read held in the editor's
  memory. A file you have open is still linted as it is in the editor,
  unsaved edits included.
- **`--format sarif`** for GitHub code scanning and security dashboards, and
  **`--format junit`** for test reporters. In JUnit only an error is a failed
  case, since only an error fails a run.
- **A GitHub Action**, `nolindnaidoo/jevlint-le`, that annotates a pull
  request, and **a pre-commit hook**. Both run the published command line at
  the version they were released with.
- **Every rule has its own page**, in `docs/rules/`: what it catches, an
  example that is flagged with the message the linter gives, one that is not,
  how to fix it and how to silence it. A finding in the editor links to its
  page, which links on to the TypeSafe page the rule comes from. JSON output
  and the MCP server's `list_rules` gain a `page` beside `docs`.
- **A request whose only question had its type misspelt was not reported.**
  `"type": "nuol"` was caught beside a valid question and missed on its own,
  and a file holding only that was never read. Both are fixed, and the same
  goes for a lone question with criteria and no type.
- The npm package can be required as a library: `lint`, `fix`, `rules`,
  `syntaxes` and an `api` number. This is what the editor loads. A syntax it
  does not have is refused with a message naming the four it does.
- Check with Jev and the probe always run the extension's own code. They
  spend your key, and are not handed to code from a workspace.

## 0.2.0 — 2026-10-05

### Check with Jev from the command line

- `--jev` runs the checks that ask Jev itself, `JEV301` to `JEV312`, the same
  ones the editor's **Check with Jev** command runs. It sends the same
  requests the editor sends for the same file.
- The key is read from `TYPESAFE_API_KEY`. Nothing in a settings file can
  turn `--jev` on.
- `--jev-plan` says what would be sent and sends nothing.
- `--jev-model`, `--jev-max-calls` and `--jev-send-state`. The call limit is
  for the whole run, and a run that needs more exits 2.
- A rejected key, a failed request or a stopped run exits 2 and says how many
  requests were answered of how many were planned.

### Fixing

- `--fix` writes the fixes that only mend what the API would refuse: a
  renamed criteria key, a mistyped question type, criteria in the wrong
  shape. The summary of any run says how many findings it would mend.
- The editor offers the same as `source.fixAll.jevlint-le`, so fix on save
  works.
- Adding a fallback option and pinning a model are never written unasked.
  They change what a working request does, and stay on the lightbulb.

### New rule and settings

- `JEV010 unused-disable` reports a `jevlint-le-disable` comment that
  silences nothing. On by default as a warning.
- `exclude` in `jevlint-le.json` lists files and folders not to lint. The
  command line, the MCP server and the editor leave out the same files.
- A rule can be named by its name as well as its code, and `warn` is taken as
  `warning`, in `--rule` and in `jevlint-le.json`.

### Command line

- `-h`, `-v`, `-f` and `-c` work. `-h` used to answer "No such file or
  directory: -h".
- `--no-error-on-unmatched-pattern` passes a run that finds no file to lint,
  for lint-staged and for packages with no Jev code. Without it that run
  still exits 2.
- `--color` and `--no-color`. `NO_COLOR` is respected.

### Changed

- **The terminal output is grouped by file**, with the rule named and the
  message wrapped under it, in colour when a terminal is reading. The
  one-line `path:line:column` form is now `--format compact`. **`--format
  text` is removed**, so a script that passes it needs `compact`.
- JSON output gains `totals.fixable`, `totals.excluded` and `totals.unread`
  on every run, `totals.fixed` under `--fix`, and `totals.jev` under `--jev`
  or `--jev-plan`.
- The README lists every command with its id, for binding to keys.

### Fixed

- **A reply from TypeSafe that was not a Jev reply crashed the run.** A proxy
  or sign-in page answering 200 threw out of the client. The command line
  lost its report, and the editor's command failed after the requests were
  paid for. It is now reported as its own failure.
- **A server error was blamed on the request and never retried.** A 5xx or a
  408 now retries like a busy service, and is reported as TypeSafe's fault.
  `Retry-After` is honoured, up to 30 seconds.
- **A request with no answer waited forever**, which held a CI job until the
  job was killed. It is given up on after 30 seconds.
- **Cancelling during the wait before a retry** took up to four seconds to be
  noticed. It is now immediate.
- **The MCP server ended on one bad input.** A line holding `null`, or a tool
  that threw on a folder it could not list, took the server down and the
  agent lost its tools. Both are now answered as failures.
- **One unreadable folder ended a command line run**, and so did a linked
  folder that led back to its parent. Unreadable folders and files are now
  named in the summary and the rest is linted. Linked folders are not
  followed. A run in which nothing could be read still exits 2. JSON output
  gains `totals.unread`.
- **Jev's findings could be shown on text they were not about.** An edit
  during a check cleared the old findings, then the check wrote its own back
  with positions from the text it had read. An edit or a close now stops the
  check and drops its findings, with a message. A second check of a file is
  refused while one is running.
- **A second Lint Workspace wiped the first one's findings.** It is refused
  while one is going. The run now shows progress and can be stopped.
- **A reader that failed in the editor left stale findings on screen** with no
  message. The findings are cleared and the status bar says why. On the
  command line the file is named and the other files are still linted.
- **A settings file that vanished between being found and being read** threw.
  It is reported like any other that cannot be used.
- **The size limit was counted in characters in the editor and bytes on the
  command line**, so a file of mostly non-ASCII text could be linted in one
  and skipped in the other. Both count bytes.
- **Standard input had no size limit**, so piped text was the way around the
  one files are held to.
- **What Jev said stayed on screen after a rule was switched off.** It is now
  cleared when the settings change.
- **A file with thousands of findings was slow**, because duplicates were
  removed by comparing every finding with every other.
- **The probe kept every report it had made** for the life of the window. It
  keeps the latest 20.
- **Piping a large report into a command that closes early**, such as `head`,
  crashed with a stack trace and status 1.

## 0.1.0 — 2026-10-04

First release.

- Ten rules, `JEV000` to `JEV009`, over Jev questions read from JSON, JSONC,
  JavaScript and TypeScript, from `@typesafe-ai/sdk` helper calls, and from
  `oxlint-plugin-jev` configs.
- Diagnostics as you type, a status bar count that includes questions the
  reader could not see whole, and a quick fix that adds a fallback option to a
  Choice.
- Commands to lint the active file and the workspace.
- Suppression by comment directive and by setting.
- A JSON schema for `*.jev.json` request bodies and snippets for the three
  question types.
- Findings from a workspace run stay when the editor closes the files it read.
- Commands return without waiting for their notification to be dismissed.
- Eleven wording rules, `JEV101` to `JEV111`, for double negatives, arithmetic,
  date comparison, compound questions, generation, multi-hop questions,
  negated and inverted Nouls, and weak Score levels. Eight are on by default.
  Each default follows from a score against a labeled corpus.
- Helper calls are read only for names imported from `@typesafe-ai/sdk`.
- The Vercel AI SDK's `boolean` question type is read as a Noul.
- Missing instructions are no longer reported, and a question built with a
  spread or with another client's field names is not told a field is missing.
- A twelfth wording rule, `JEV112`, for questions that turn on a word with no
  stated line, such as large, often or enough.
- The double-negative, arithmetic, date, compound, generation, negated-Noul
  and degree-level rules were rewritten after three runs over public code.
- Wording rules skip non-English text, template slots and guidance sentences.
- A missing `criteria` is reported only inside a request. A one-option Choice
  and a one-level Score are informational.
- The date, degree-level, arithmetic and undefined-boundary rules catch five
  defects found by hand in a random sample of 300 real questions.
- Wording defaults now follow measurements against `jev-1.13.0`. Double
  negatives are informational. Date comparison, negated Nouls, inverted
  criteria and degree-word levels are off: Jev answered them correctly.
- **Check This File with Jev**: an opt-in command that asks Jev itself about
  each question, for overlapping options, overlapping levels, counting and
  undefined boundaries. It uses your own API key, stored in the system
  keychain. Linting still makes no network request.
- Quick fixes for a pinned model, `yes`/`no` criteria, a mistyped type, and
  Score or Choice criteria in the wrong shape.
- The overlap checks point at the options or levels Jev thinks are at fault.
- Date comparison is back on as informational: Jev lost an answer and a
  quarter of its certainty on a window counted in days.
- Eight more checks in **Check This File with Jev**: mismatched option names,
  off-topic criteria, a Choice that is a scale, a Score that is a set of
  categories, a question that depends on another, two questions that ask the
  same thing, and, with `jev.sendState` on, a state that lacks the answer or
  carries orders.
- **Check This File with Jev** shows the request count, a token and cost
  estimate and what it will send, and waits for a yes.
- **Probe the Jev Question at the Cursor**: sends one question against its
  state with the layout changed, and reports whether the answer moved.
- Python: dicts, the `typesafe_sdk` question classes, wrapper libraries that
  re-export them, and `system_one(...)` requests. Every rule, quick fix and
  Jev check works on them.
- A command-line version of the linter, with text, JSON and GitHub annotation
  output, for CI and other editors. On npm as `jevlint-le`.
- Rust and Go: the JSON inside `json!`, Go maps, structs and enum variants
  named for a question type, and Rust constructors.
- A request pasted as JSON into a string is read in every language.
- A name bound to a literal in the same file is followed to it, so a prompt
  or a set of options kept in a constant is linted where it is written.
- Templates, format calls and joined strings are linted for their fixed
  text.
- A function that builds a question from its parameters is read at each call,
  so questions passed to a local helper are linted where they are written.
- An MCP server, so an AI agent can lint the Jev questions it writes. It is
  the same program as the command line, run with `--mcp`.
- Right-click entries in the editor for linting, checking with Jev and
  probing the question at the cursor.
- Agents running in VS Code get the MCP server with no setup.
- A cancelled Jev check or probe now says it was cancelled, a probe result is
  no longer lost when its report cannot be opened, and a locked keychain is
  reported and falls back to the environment key.
- A `jevlint-le.json` in the project sets the rules for the editor, the
  command line and the MCP server alike.
- Quick fixes to disable a rule for a line or a file.
- The message shown in an untrusted workspace now says how to trust it.

- The message for a missing key has a button that sets one, and the one for
  an untrusted workspace has a button that opens workspace trust.

- The check for a question that depends on another one is stricter, after it
  misfired on its first real use.

- The confirmation before a paid command is one question and one line.
- The API key can be typed into user settings as well as stored in the
  keychain.
- The confirmation before a paid command is off by default and can be turned
  on in settings.
- A setting for how much is said in notifications: everything, only what
  matters, or only why a command could not run.

- The probe report opens as a rendered page, and closing it no longer asks to
  save.
