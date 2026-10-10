# AGENTS.md — JevLint-LE

Technical source of truth for this repo. [SPEC.md](SPEC.md) says what the
product is and what is planned. [README.md](README.md) is user-facing.

## What this is

A VS Code extension that finds the questions a project sends to TypeSafe's Jev
model or to OpenAI's Decisions API (`gpt-6-luna`), in JSON, JavaScript,
TypeScript, Python, Rust and Go, and reports the ones written in a way
measured to fail. Linting uses no network and no API key. One command, run by
the user with their own key, asks the model to check a file. No filesystem
writes outside an accepted quick fix.

**Status:** released as 0.2.0 on 2026-10-05, after 0.1.0 on 2026-10-04. The name
appears in `package.json`, the `jevlint-le.*` settings and commands, the
`jevlint-le-disable` directive and the diagnostic source.

## Architecture

```
extension.ts             activate(): linter + status bar + commands + listeners
extraction/
  tokens.ts              lexer for JS, TS, JSON, JSONC. Strings, templates,
                         comments, regex-versus-division
  cursor.ts              token-walking helpers: skip an expression, skip a
                         balanced group
  reader.ts              tokens -> a tree of literals. What is not a literal is
                         an `unreadable` node, never a guess
  pythonTokens.ts        lexer for Python: prefixed and triple-quoted strings,
                         f-strings, comments
  pythonReader.ts        Python tokens -> the same tree, with SDK calls read as
                         the dicts they stand for
  lexKit.ts              pieces the Rust and Go lexers are built from
  rustTokens.ts          lexer for Rust: raw strings, lifetimes, characters
  goTokens.ts            lexer for Go: raw strings, runes
  braceReader.ts         the reader for languages that write a literal as a type
                         and a brace. What differs is a `Dialect`
  rustReader.ts          the Rust dialect: macros, wrappers, constructors
  goReader.ts            the Go dialect: map, slice and struct types
  embedded.ts            JSON pasted into a string, in any language
  bindings.ts            a name -> the literal it is bound to, when that is safe
  functions.ts           the functions a file defines, with their parameters
  wrappers.ts            a function that builds a question, and its calls as the
                         questions they build
  slots.ts               the fixed text of a template, a format call or a joined
                         string, with a placeholder per runtime part
  requests.ts            tree -> questions, question maps, model names
lint/
  limits.ts              every vendor fact a rule depends on, with URL and date
  rules.ts               the rule registry: code, name, default severity, docs
  finding.ts             shared types and helpers for checks
  checks.ts              question-level rules and the `check` entry point
  optionChecks.ts        rules over Choice options and Score levels
  wordingChecks.ts       heuristic rules over how a question is worded
  lexicon.ts             the word lists and patterns those rules match
  fix.ts                 the text edits, each marked safe or not
  fixAll.ts              a text with every safe fix applied
  suppress.ts            comment directives
  lint.ts                lintText(text, options): the pure entry point
jev/
  literal.ts             a question as plain data, or nothing if any part is runtime
  reviews.ts             the checks Jev makes: what is asked, the cutoff, the message
  review.ts              what a check of one text would send, and the sending of it.
                         The editor and the command line both run this
  client.ts              one request to the API, with a bounded retry
  provider.ts            the two vendors a check can be put to: endpoint, key, the
                         request on the wire and the reply read back
  probe.ts               the layout variants of one question, and the report
cli/
  args.ts                the flag table: one entry parses a flag and prints its help
  files.ts               paths -> the files to lint
  format.ts              stylish, compact, JSON, GitHub annotation, SARIF and JUnit output
  run.ts                 run(argv, io) -> exit status. Everything but the process
  jev.ts                 --jev: the plan across files under one call limit, and the run
  mcp.ts                 the MCP server: five read-only tools over the same
                         linting, the fixes and the rule pages
  main.ts                the process: real filesystem, streams and exit code
services/linter.ts       diagnostics collection, per-document results, debounce
services/reviewer.ts     shows what jev/review.ts finds in a document, in its own collection
services/mcpProvider.ts  offers the bundled MCP server to agents in the editor
ui/                      diagnostics mapping, status bar, quick-fix provider
ui/notifier.ts           every notification, gated by `notificationsLevel`
commands/                lint file, lint workspace, open settings
commands/jev.ts          check with Jev, set and clear the API key
commands/probe.ts        probe the question at the cursor
config/config.ts         getConfiguration() snapshot; CONFIG_DEFAULTS
config/installed.ts      the copy of this tool a project has installed, read from its manifest
config/projectConfig.ts  jevlint-le.json: parsing it and finding the one that applies.
                         No `vscode`, so the command line shares it
services/projectConfigs.ts  the settings for a document, and a watch on the files
services/installedCopies.ts  the installed copy for a document, kept for a few seconds
services/diskDocument.ts  a file's text as a document, for a workspace run that opens nothing
services/engines.ts       which linter a document gets: the project's copy or the bundled one
services/loadModule.ts    loads a project's copy fresh, so an upgrade is picked up
lib.ts                    what the npm package exports as a library, for the editor to load
docs/rulePages.ts         the page for each rule, written from the registry and checked examples
types.ts                 types only
```

`extraction/`, `lint/`, `jev/` and `cli/` never import `vscode`. `lintText` is
the seam the command line and the MCP server call.

## Code style

The LE family standard applies: guard clauses first, no `else`, at most two
levels of nesting, factory functions returning frozen objects, no classes,
immutable data, logic separate from presentation, comments that explain why.
The full text with its reasons is in
[`../regex-le/AGENTS.md`](../regex-le/AGENTS.md) under "Code style". It is not
copied here because a copy drifts.

`biome.json`, `tsconfig.json`, `vitest.config.ts` and `.editorconfig` are the
family's files, copied unchanged from `regex-le`.

## Invariants

- **The reader refuses rather than guesses.** A value that is not a literal is
  `unreadable`. An object with a spread, a computed key or a method is
  `partial`. A rule that needs such a value does not run, and `JEV000` says so.
  Never make a rule fire on a partial value.
- **The unread count is taken before suppression.** Switching `JEV000` off
  hides the hints and leaves the count, so an unread file never looks clean.
- **Duplicate keys must survive the reader.** `JEV005` depends on it, which is
  why JSON is read by this reader and not by `JSON.parse`.
- **No vendor number outside `lint/limits.ts`.** Each entry carries the page it
  was read from. `VERIFIED_ON` is the date.
- **The rule tables in SPEC.md and README.md must equal `lint/rules.ts`.**
  `lint/rules.test.ts` fails when code, name or default severity differ, and
  when the README's "What it means" column is not the registry's `meaning`.
- **`CONFIG_DEFAULTS` must equal the defaults in `package.json`**, and every
  declared command must be registered. `extension.test.ts` holds both.
- **A fix must not guess.** `fix.ts` returns no edit when anything but
  whitespace and one comma follows the last option.
- **A fix is safe or it is not, and only safe ones are applied unasked.**
  `Fix.safe` is true when the edit only mends what the API would refuse.
  `--fix` and fix on save apply those and nothing else. An edit that changes
  what a working request does, such as a new option or a pinned model, is a
  quick fix for a person to accept. A new fix states which it is.
- **The command line writes a file only under `--fix`.** `Files.write` has no
  other caller.
- **`stylish` is for people and the other formats are for programs.** Only
  `stylish` is coloured or may change shape between releases. `compact`,
  `json`, `github`, `sarif` and `junit` are read by editors and CI.
- **In JUnit only an error is a failed case.** A warning that failed there
  would turn a CI report red on a run that exited 0.
- **`action.yml` and `.pre-commit-hooks.yaml` pin the version they ship
  with,** and `cli.test.ts` holds both to `package.json`. Neither can work
  for a version until that version is on npm, so they are only meaningful at
  a release tag. The action passes its inputs as environment variables and
  never splices one into its script.
- **`exclude` is decided in one place,** `isExcluded` in
  `config/projectConfig.ts`, for the command line, the MCP server and the
  editor. Text handed over directly, on standard input or to `lint_text`, is
  never excluded.
- **A comment is unused only if nothing it could silence was reported.**
  `JEV010` is worked out after every finding has been asked about, and never
  for a comment that names only Jev-backed rules. It is not silenced by a
  comment, or a bare one would hide the report of itself.
- **Where a `jevlint-le.json` applies it replaces the editor's lint settings.**
  It is never merged with them. The point of the file is that the editor and
  the command line report the same findings, and `extension.test.ts` runs
  both on one file to hold that.
- **A settings file that cannot be used stops linting.** Falling back to
  defaults would show findings CI does not, or hide ones it does. The editor
  clears the file's findings and says why. The command line exits 2.
- **The settings file is parsed in one place**, `config/projectConfig.ts`, and
  its schema must list the same keys and levels. A test holds them together.
- **A silencing comment is never written into a string or into strict JSON.**
  `inString` marks a finding in pasted JSON, and `COMMENTS` lists the
  languages that have a comment to write.
- **Every way the editor can fail has a switch in the mock.** `secretsError`,
  `showDocumentError` and `cancel` exist because a path the mock cannot fail
  is a path no test has run. Five defects were found the day they were added.
  A new call into the editor that can fail gets its switch and its test.
- **A run the user stopped never reads as one that finished.** The Jev check
  says how many requests were answered of how many planned. A cancelled probe
  makes no report. A request cut off by a cancel is not a network failure.
- **A keychain that cannot be read is not a keychain with no key.** `findKey`
  returns the key or the sentence that says which it was, and tries the
  environment either way.
- **The extension ships the command line as `dist/cli.js`**, because the MCP
  provider starts it. The provider id in `services/mcpProvider.ts` must equal
  the one in the manifest, and `extension.test.ts` holds them together.
- **A command never awaits a notification.** The promise settles when the
  toast closes, so awaiting it holds the command open.
- **Every notification goes through `ui/notifier.ts`,** so the
  `notificationsLevel` setting governs all of them. Pick by what the user
  loses if the message is hidden: `result` for a summary of a run that
  worked, `caution` for a run that fell short, `blocked` for why a command
  did nothing. `blocked` is shown at every level. A modal that waits for an
  answer is an interaction, not a notification, and is called directly.
- **A workspace run opens nothing.** It reads each file from disk through
  `services/diskDocument.ts` and uses the editor's document only for a file
  that is already open, which can hold unsaved edits. Opening every file left
  each one held in the editor for minutes. `extension.test.ts` fails if a run
  opens a document.
- **A file read from disk gets its language from `LANGUAGE_BY_EXTENSION`.** It
  must list exactly the extensions in `EXTENSIONS`, and a test holds the two
  together. A new file type is added to both.
- **Workspace-run findings are kept when the user closes a file they opened
  from them.** Without `keep`, looking at one result would drop it. They are
  dropped by the next workspace run.
- **The icon is `src/assets/images/icon.png`**, 256 pixels square with a
  transparent background, drawn from `icon-source.svg` beside it. It is a
  placeholder the owner may replace. The installed-extension test fails if it
  does not ship.
- **The README's only relative links are the two demo images.** `vsce
  package` rewrites them to the repository's raw URL, which works because the
  manifest names the repository and the repository is public. Any other
  relative link would point at a file that does not ship.
- **Both demos are recorded, not drawn.** `assets/demo.gif` is the editor:
  `scripts/record-editor-demo.mjs` drives a private copy of VS Code with
  Playwright and records the window. `assets/demo-cli.gif` is the command
  line, driven by `assets/demo-cli.tape` with `vhs`. Record one again when
  what it shows changes. The LE Tools site reads `assets/demo.gif`.
- **The editor take opens a VS Code window for about 25 seconds.** Say so
  before running it on someone's machine. Hot exit must stay on in
  `assets/demo/editor/settings.json`, or closing the window stops on a save
  dialog.
- **The schema does not validate what a rule validates.** In a `*.jev.json`
  file both would underline the same token. The schema describes fields and
  requires the top-level keys. Rules own everything about a question.
- **A finding underlines the thing that is wrong.** An unknown type points at
  the type value and a wrong criteria shape at the `criteria` key. The question
  id is the anchor only when the problem is the question as a whole.
- **Messages quote with `'`, never backticks.** Diagnostics are plain text, so
  a backtick shows up as a backtick.
- **A wording rule's default is earned, not chosen.** `lint/corpus.test.ts`
  scores every wording rule against `fixtures/corpus/questions.json` and fails
  if a rule is on by default while firing on a good question. Changing
  `lexicon.ts` changes `scores.json`: regenerate it with `-u` and read the
  diff.
- **The corpus is ours and is not evidence.** It has the same author as the
  rules. When a rule is wrong on a real question, add that question in your
  own words with the right label. Never copy questions from another project
  or from vendor docs into it. Before turning a rule on, run it over questions
  it was not built from and read the findings.
- **A lone broken question is recognised by a narrow test, and only that
  test.** A `questions` map with no valid entry is read as questions when an
  entry has `instructions`, no field a question lacks, and a type one slip
  from a real one or criteria with no type (`isBrokenQuestion`). `bool`,
  `multiple` or one foreign field leaves the map alone. Run over 783 public
  files on 2026-10-05, 354 of them unrelated code that says "questions" and
  "instructions": it added no finding. Loosening it needs that run again.
- **Nothing is concluded from what a lone object lacks.** A missing `criteria`
  is reported only for an entry in a `questions` map or an SDK helper call
  (`inRequest`). An object with a spread or another client's fields (`open`)
  gets no shape finding at all.
- **A wording rule reads the asking sentence.** Long instructions put guidance
  after the question, and guidance is full of "not", "before" and "and".
  `asked()` returns the sentences that end in a question mark, or the first
  sentence when none does.
- **Negative words are listed, never matched by prefix.** "instructions",
  "independent" and "invent" start like negatives. A prefix pattern made the
  double-negative rule wrong 24 times on public code.
- **Three kinds of evidence, in rising order of worth.** The corpus says a
  rule fits examples its author wrote. `fixtures/public-sample/` says what a
  rule catches and misses on real questions labeled before it ran. Only
  `scripts/validate-defects.ts` says whether the defect costs Jev answers.
  Do not quote a corpus score as a catch rate.
- **A wording rule is on only where a run against Jev showed a cost.** The
  rule for reading a run is fixed before it: proven at two or more answers
  lost, advisory at 0.10 less sure, otherwise off. Results are in
  `fixtures/validation/`. They are true of one model version, so rerun
  `bun run validate` and again with `--set hard` and `--set encoding` when Jev releases
  another, and move the defaults with the result.
- **A sample is spent once a rule is fixed against it.** Draw a new one for
  the next measurement. `fixtures/public-sample/` is spent.
  `fixtures/public-sample-2/` is not: no rule has been changed because of it.
- **A sample is drawn and scored by script, and labelled by hand in
  between.** `scripts/draw-public-sample.ts` writes the question text outside
  this repo and leaves out everything an earlier sample used. The labels are
  committed on their own before `scripts/score-public-sample.ts` is run, so
  the history shows they came first.
- **Every experiment must mean what its rule means.** `validation.test.ts`
  fails if a rule does not flag an experiment's bad question or flags its
  fixed one.
- **Run a rule change over public code before trusting it.** Three rounds of
  that found more wrong with these rules than every test in the repo. The
  corpus cannot do this job, because its author wrote the rules.
- **Helper calls are read only for names imported from the SDK**, never for a
  method call or a declaration. 40 of 46 false findings on public code came
  from breaking one of these four: this, foreign field names, the `boolean`
  alias, and claiming a field missing on an object with a spread.
- **A reader's only output is the tree.** Rules, fixes and Jev checks never
  ask which language a file is in, with one exception: `CheckContext.syntax`
  tells a fix how to write an edit. A new language is a new reader and
  nothing else.
- **A name is followed only when nothing could have changed it.** Bound
  exactly once in the file, not a parameter anywhere in it, never assigned
  into or changed through a method, and not an empty container. The reader
  has no scopes, so each condition stands in for one. Loosening any of them
  needs a run over public code first.
- **A wrapper is not a question, and each call to it is.** Reading is done
  twice when a file has wrappers: once to find them, once keeping their calls.
  A call is read only when its name is defined once in the file, is not a
  method, and builds exactly one question.
- **A string with `slots` is fixed text, not the question.** A rule may run
  on it only if the fixed text alone can answer it. A rule that fires on
  something being absent must skip it. It still counts as not fully read,
  and `toLiteral` refuses it, so Jev never sees it.
- **A finding on a followed name is reported where the literal is written.**
  A mistake in a literal that two questions share is reported once.
- **A project's own type is not the API's shape.** In Rust and Go, criteria
  held in a named type are unreadable, a struct with a field the API lacks is
  partial, and a struct with no `type` field is never reported as missing
  one. Each of these was a false finding on public code first.
- **A name means a question type only when it holds exactly one of the three
  words** (`typeInName`), and a typed struct is a question only when it has an
  `instructions` or `criteria` field. `Answer::Noul { noul }` has neither.
- **JSON in a string is read only when the string has no escapes.** Then a
  position in the value is a position in the file. With escapes it is not,
  and a finding would underline the wrong text.
- **An edit inside embedded JSON is written as JSON.** `syntaxAt` answers per
  position, so a fix in a Python file's JSON string writes `null`, not `None`.
- **No reshape fix in Rust or Go.** Turning a list into a map is spelt
  differently for every type, so none is offered.
- **A Python class is a question on one of two grounds.** Its name is imported
  from `typesafe_sdk`, or its arguments are exactly the keywords
  `instructions` and `criteria`. A `Choice(title=..., value=...)` from another
  library is neither. Do not loosen the second without a run over public
  code.
- **A value under a runtime key is kept as `loose`.** Its key is gone, so it
  has no id and joins no map, but a question written there is still linted.
  Only the Python reader does this.
- **Text in backticks or double quotes is not the question's wording.**
  `prose()` removes it before any wording rule reads.
- **Only four callers may reach the network:** `commands/jev.ts`,
  `commands/probe.ts` and `services/reviewer.ts` in the editor, and
  `cli/jev.ts` under `--jev`. `lintText` and everything under it stay
  offline. `extension.test.ts` fails if linting calls `fetch`, and
  `cli.test.ts` fails if a run without `--jev` does. Two hosts, and only two:
  `api.typesafe.ai` for a Jev model and `api.openai.com` for `gpt-6-luna`,
  chosen by `jev/provider.ts` from the model id, each with its own key.
- **A question carries its dialect.** `extraction/requests.ts` reads
  TypeSafe's, OpenAI's and the AI SDK's shapes into the same `criteria`, so a
  rule never looks at `choices` or `options`. Only the shape rule and the
  fixes read `criteriaRaw`. A rule about TypeSafe's API limits checks the
  dialect first.
- **The editor and the command line send the same requests for the same
  text.** Both call `jev/review.ts`, and `extension.test.ts` compares the
  request bodies. A check added to one is added to both by construction.
- **Only a flag turns `--jev` on.** Never a key in `jevlint-le.json`, or a
  cloned repository could spend the key of whoever lints it. This is the
  command line's workspace trust.
- **The command line's key is `TYPESAFE_API_KEY` and nothing else.** No flag
  takes it, so it cannot reach shell history or a CI log.
- **The call limit on the command line is for the run, not the file.** Each
  file is planned with what the files before it left. A run that needed more
  exits 2, as does one that failed or was stopped.
- **The MCP server never calls Jev and never writes a file.** Its tool
  descriptions say it sends nothing, `--jev` with `--mcp` is refused, and
  `fix_text` returns the mended text in place of writing it. That is what
  lets every tool carry `readOnlyHint`, and a test fails if one does not.
- **Every MCP tool declares an `outputSchema` and answers with
  `structuredContent` equal to its text.** A client reads either. A tool
  that answers prose, `explain_rule`, puts the page in both.
- **The API key lives in secret storage, the environment, or the user's own
  settings, and never in a workspace's.** The `jev.apiKey` setting has
  application scope and `ignoreSync`, and a test fails if either is removed,
  because a workspace setting is a file in the repository. No message,
  finding or error may contain the key. The client returns
  the status code of a failure and not the response body, which can echo the
  request.
- **What the user agrees to is what is sent.** `reviewer.plan` and
  `reviewer.review` both come from one `prepare`, so the request count in the
  confirmation cannot drift from the run.
- **A probe changes layout, never wording.** A reworded question changes its
  meaning too, and then a moved answer proves nothing.
- **State is sent only when the user turns `jev.sendState` on,** and only a
  state written out in the file. The request builder adds it, and the ids of
  sibling questions, only for the checks that read them.
- **Jev is never shown a question with holes.** `toLiteral` returns nothing
  when any part is built at runtime, and the run counts what it held back.
- **No test calls TypeSafe.** `fetch` is stubbed. The scripts under `scripts/`
  that do call it are run by hand, and each has a `--dry-run` and a call limit.
- **A reply is a Jev reply or it is a failure.** `jev/client.ts` checks the
  shape before reading it. A 200 from a proxy read as "no answers" would
  report a clean check that never ran.
- **Every request has a time limit, and a stop ends a wait at once.** A
  stalled connection would otherwise hold a CI job until it was killed.
  Only `busy` and `server` failures are retried.
- **A run on a document ends when the document changes.** `reviewer.clear`
  stops the run and marks it overtaken, and an overtaken run shows nothing.
  One run per document at a time.
- **The MCP server answers everything and exits only when its input closes.**
  A tool that throws is a failed call. A line that is not a request is a
  protocol error.
- **What the command line could not read is named, never passed over.** An
  unreadable folder or file and a file the reader failed on go in
  `totals.unread`. A linked folder is not followed, because it can lead back
  to its parent. A run that read nothing exits 2.
- **`linter.lint` does not throw.** It runs in timers and events, where a
  throw is lost. A reader failure clears the file's findings and is shown as
  the reason the file was not linted.
- **One workspace run at a time.** A second would reset the findings the
  first is adding to.
- **A project's installed copy is found by reading its manifest, and only
  that.** `config/installed.ts` looks in the `node_modules` nearest the file,
  no higher than the workspace folder.
- **A project's copy is loaded only in a trusted workspace.** Loading it runs
  code from the project. `services/engines.ts` is the one place that decides,
  and `extension.test.ts` fails if an untrusted workspace loads anything.
- **The editor never stops linting for want of a project copy.** No copy, an
  untrusted workspace, a copy too old, one that fails to load or one that
  does not read the file's language all fall back to the bundled linter. Every
  fallback but "none installed" is named in the status bar with its reason.
- **`src/lib.ts` is a promise.** The npm package exports it and editors of
  other versions load it. Add names freely. Change or remove one only by
  raising `api`, which makes older editors fall back instead of misreading.
  `scripts/e2e-cli.js` holds the names and the `main` entry that locates it.
- **A finding can carry a rule this extension does not know.** A project's
  copy can be newer. `toDiagnostic` takes the docs link from the copy that
  found it and must not index `RULES` with a foreign code.
- **Check with Jev and the probe never use a project's copy.** They spend the
  user's key, so they run the code the user installed as an extension.
- **File size is counted in bytes in both places.**
- **The pinned model and the call limit are defined once,** in
  `jev/review.ts`. The editor's defaults and the command line's read them.
- **A Jev check's cutoff is read from `fixtures/validation/calibration.json`,**
  never guessed. `reviews.test.ts` fails if a cutoff would flag a good corpus
  question. Rerun `scripts/calibrate-reviews.ts` when the model changes.
- **The command line refuses where passing would mislead.** An unknown option,
  a named file of a type it does not read, a config key it does not know and
  a run that found nothing to read all exit 2. Never turn one into a warning.
- **The file types read are listed once, in `EXTENSIONS`.** The editor's
  `include` default is built from it and the command line searches by it. A
  new language adds its extension there, a reader in `LANGUAGES` in
  `lint/lint.ts`, an `onLanguage` activation event and an entry in the
  linter service's `LANGUAGES`.
- **One npm package is the command line, the MCP server and the library.** It is
  assembled in `npm/` by `bun run build:npm`, which writes the root manifest's
  version into `npm/package.json`. Never edit that version by hand.
  `scripts/e2e-cli.js` fails if the two differ or if anything but the bundle,
  the manifest, the readme and the license would be uploaded.
- **Three files carry the version, and CI fails unless they agree:**
  `package.json`, `npm/package.json` and `server.json`, both its `.version`
  and `.packages[0].version`. The same step holds `server.json.name` to the
  manifest's `mcpName`, `.packages[0].identifier` to the npm name, and
  `--mcp` among the package arguments, without which a client would start
  the command line. Not relaxable: the registry verifies ownership by reading
  `mcpName` out of the published package, so a mismatch is found only after
  the version is spent, and a version can never be republished.
- **The MCP server returns what `--format json` prints.** Both come from
  `toReport`, so an agent and a CI job read one shape.
- **`cli/run.ts` takes its filesystem and streams as arguments.** Only
  `cli/main.ts` touches the process, and `scripts/e2e-cli.js` is its test.
- **A new rule ships with three tests:** it fires, it does not fire, and it
  stays quiet on a value it cannot read. A rule the linter runs offline also
  ships with a pair in `fixtures/rule-examples.json`.
- **Rule pages are generated, never edited.** `bun run docs:rules` writes
  `docs/rules/` from the registry, whose `meaning` is each page's first line,
  and `fixtures/rule-examples.json`. `docs/rulePages.test.ts` runs the linter
  on every example and fails when a page on disk is not what would be written
  now. To change a page, change its source and run the script. The examples
  are imported into `docs/rulePages.ts`, so they ship inside the bundle and
  `explain_rule` renders the same page offline. A test holds the import to
  the file.
- **A good example has nothing wrong with it.** The test runs every offline
  rule over each one. An example that trips a second rule teaches the wrong
  thing.
- **`docs` is the vendor page and `page` is ours.** A finding links to
  `pageFor(code)`, and the page links on to `docs`. The pages live on the
  default branch, so a rule's page exists once the rule is merged.

## Toolchain

- **Build:** esbuild bundle to `dist/extension.js`. `tsc` is typecheck-only.
- **Tests:** vitest, with `vscode` aliased to `src/__mocks__/vscode.ts`. The
  mock covers only what this extension calls and exposes `_state` and `_reset`.
- **Lint and format:** Biome, tabs, single quotes.

```bash
bun run typecheck && bun run lint && bun run test
bun run test:integration
bun run package && bun run test:e2e-vsix
bun run test:cli                # builds npm/cli.js, runs it as a process, checks the package
bun run validate -- --dry-run   # what would be sent to Jev, no key needed
```

## Verified in a real editor

- `bun run test:integration` launches a real VS Code on `samples/` and asserts
  the diagnostics, their ranges and severities, the quick fix, re-lint on edit,
  the settings switch and the workspace command. `samples/` is the fixture: its
  files hold planted mistakes, and the expected codes are listed at the top of
  `test/integration/extension.test.ts`. Change a sample and that table together.
- `bun run package && bun run test:e2e-vsix` installs the VSIX into a clean
  profile and checks that it activates on its own when a JSON file opens, that
  every file the manifest points at shipped, and that the contributed schema
  validates `*.jev.json`. It is the only test of the artifact users install.
- The integration tests edit samples in memory and revert. They never save.

## Not done

- No Rust port of the command line, by decision. See the roadmap in SPEC.md.
- No localization, by decision. See the roadmap in SPEC.md. The sibling
  repos have it and the Rust port, and SPEC.md lists them under Extended
  release 2.
- Not compared by the family's fleet check. See below.
- The shell does not yet follow the family layout: no `services/serviceFactory`,
  `telemetry/` or `config/settings`.

## Known limitations

- Wording rules read English. A question that is mostly in another script is
  skipped with no notice. One in another Latin-script language is read as
  English and mostly finds nothing.
- An aliased import, `import { choice as pick }`, is not followed, so `pick(...)`
  is not read as a question.
- The reader is a lexer and a literal parser, not a JavaScript parser. A TypeScript
  type literal such as `{ type: 'noul', instructions: string }` reads as a
  question with unreadable instructions and gets a `JEV000` hint.
- A generic call with a comma in its type arguments, such as `f<A, B>(x)`,
  inside an object literal makes that object unreadable as a whole. Objects
  nested inside it are still found.
- In Go, constructor calls are not read. In Rust, a map built with `insert`
  calls or a `hashmap!` macro is not read.
- In Python, `dict(type='noul', ...)`, a question class called through a
  variable, and a questions dict passed under a name that does not end in
  `questions` are not read.
- Suppression directives are matched as text, so the phrase inside a string
  also counts.

## Automation

The workflows, hooks and agent files come from the family, whose reference is
`regex-le`. Some are byte-for-byte copies and some are cut down, and the
difference matters when the family changes one.

| File | Relation to the family's |
|---|---|
| `.githooks/commit-msg`, `scripts/commit-lint.js`, `scripts/install-hooks.js` | Copies |
| `.cursorrules`, `.windsurfrules`, `.clinerules`, `GEMINI.md`, `.github/copilot-instructions.md`, `.cursor/rules/project.mdc`, `scripts/check-agent-files.py`, `src/agent-files.test.ts` | Copies. The six instruction files are one document, and the test fails if they differ |
| `.github/workflows/codeql.yml`, `.github/codeql-config.yml`, `.github/workflows/dependabot-auto-merge.yml`, `.gitattributes`, `.editorconfig`, `biome.json`, `tsconfig.it.json` | Copies |
| `.github/workflows/ci.yml` | Cut down: no second extension toolchain, no generated README check, no bundle gate. Adds `test:cli` |
| `.github/workflows/release.yml` | Changed: publishes `npm/` with the `NPM_TOKEN` secret where the family uses trusted publishing. The MCP registry step is the family's, in a job of its own that first waits for npm to serve the version, so a listing that fails is re-run alone |
| `.github/dependabot.yml` | Cut down: no `cargo` entry |

- **`letools-site`'s fleet check names this repo and does not compare it.** It
  is listed in `OUTSIDE_FLEET` in `letools-site/scripts/check-fleet.ts`. The
  check holds the sixteen family repos byte-identical on files this repo
  deliberately lacks or changes. Joining it means adopting those, which was
  decided against. When a copied file changes in the family, copy it here by
  hand.
- **CI pins Bun to the version that wrote `bun.lock`**, 1.3.14. Upgrading is
  one change: upgrade locally, regenerate the lockfile, and move both pins in
  `ci.yml` and the two in `release.yml`.
- **The commit hook is installed by `bun install`** through `prepare`. It
  rejects a message that is not a conventional commit or that holds an
  absolute local path. CI runs the same check on every pushed commit.
- **Releases are manual**, from the `Release` workflow, with the Marketplace,
  Open VSX and npm as separate opt-ins. A version cannot be republished, so
  each is chosen on purpose. The workflow refuses a version whose changelog
  heading is not `## <version> — <date>`, and runs the integration and
  installed-VSIX tests on the file it is about to publish.
- **A changelog heading is dated in the pull request that finishes the
  version.** Never `unreleased`. The version number is bumped and the work is
  done in that PR, so the date goes in there too, and `main` is always ready
  to tag. An undated heading hands the owner a second PR to write for a
  one-line edit, which happened for 0.3.0 and must not again.
- **Three repo secrets do the publishing:** `VSCE_PAT`, `OVSX_PAT` and
  `NPM_TOKEN`. They are kept in Doppler under `extensions` / `prd` and are the
  same ones the rest of the family uses. npm publishes by token, by the
  owner's decision, so a first release needs nothing set up on the registry.

## Git identity

Every commit uses `13629544+nolindnaidoo@users.noreply.github.com`. Check
`git config user.email` before the first commit in a fresh clone, because a
repo-local value overrides the global one.

## Commits

Conventional prefix (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `build:`,
`chore:`, `refactor:`, `perf:`, `revert:`), optional scope, imperative summary,
no trailing period. The body says why.
