# Changelog

## 0.2.0 — unreleased

- `--jev` on the command line runs the checks that ask Jev itself, `JEV301`
  to `JEV312`, the same ones the editor's **Check with Jev** command runs. It
  sends the same requests the editor sends for the same file.
- The key is read from `TYPESAFE_API_KEY`. Nothing in a settings file can
  turn `--jev` on.
- `--jev-plan` says what would be sent and sends nothing.
- `--jev-model`, `--jev-max-calls` and `--jev-send-state`. The call limit is
  for the whole run, and a run that needs more exits 2.
- A rejected key, a failed request or a stopped run exits 2 and says how many
  requests were answered of how many were planned.
- JSON output gains `totals.jev` when `--jev` or `--jev-plan` is given. It is
  unchanged otherwise.

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
