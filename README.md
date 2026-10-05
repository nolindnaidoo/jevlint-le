# JevLint-LE

Lint the questions you send to TypeSafe's Jev model. JevLint-LE reads them out of
your JSON and your code, and reports the ones written in a way that is
documented to produce bad answers. Linting makes no API calls and needs no key. One optional command asks Jev
itself to check a file, using your own key.

Part of the LE family.

![JevLint-LE in VS Code: two findings explained on hover, then two fixed with a quick fix](assets/demo.gif)

## Install

- **VS Code:** search for JevLint-LE in the Extensions view, or run
  `ext install nolindnaidoo.jevlint-le`.
- **Cursor, VSCodium and other editors that use Open VSX:** the same name,
  `nolindnaidoo.jevlint-le`.
- **Command line and MCP server:** `npx jevlint-le`. Nothing to install first.

## At a glance

- **Lints as you type** in JSON, JavaScript, TypeScript, Python, Rust and Go.
- **Fixes on the lightbulb** for the mechanical mistakes, and a way to silence
  a finding you disagree with.
- **The same rules in CI**, from a command line, and for AI agents, from an
  MCP server. One settings file covers all three.
- **Two optional commands that use your own key**: one asks Jev whether your
  questions have problems a text pattern cannot see, and one re-sends a
  question with its layout changed to see whether the answer holds.

A request like this one looks fine and has three problems:

```json
{
  "model": "jev-latest",
  "state": "My parcel came three days late and the lid is cracked.",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": { "billing": "Charges and refunds", "delivery": "Late or damaged parcels" }
    },
    "late": { "type": "noul", "instructions": "Did more than two parcels arrive late?" }
  }
}
```

| Finding | Why it matters |
|---|---|
| `JEV001` on `jev-latest` | The alias moves with each release, so answers can change with no change on your side |
| `JEV004` on `team` | A message about neither team is still forced into one of them |
| `JEV102` on `late` | Jev does not count reliably. Ask about each parcel and count in code |

## What it catches

Jev guarantees the type of its answer, not the answer. A badly formed question
still comes back with a confident-looking number. These rules catch the
mistakes that can be read from the text.

| Code | Name | Default | What it means |
|---|---|---|---|
| JEV000 | unreadable | hint | Part of the question is built at runtime, so the rules that need it did not run |
| JEV001 | unpinned-model | warning | `jev-latest` and `jev-preview` move with each release, so answers can change with no change on your side |
| JEV002 | choice-option-limit | error | A Choice has more than 255 options. The API rejects it |
| JEV003 | score-level-limit | error | A Score has more than 10 levels. The API rejects it |
| JEV004 | no-fallback-option | info | A Choice has no `other` or `none of the above`, so an input that fits no option is forced into one |
| JEV005 | duplicate | error | A question id, option or level appears twice. In an object the later one silently replaces the earlier |
| JEV006 | criteria-shape | error | A Choice needs a map of options, a Score needs an array of levels, and a Noul takes `true` and `false` |
| JEV007 | invalid-question | error | The type is missing or unknown, or the instructions are an empty string |
| JEV008 | numeric-levels | warning | Score levels are bare numbers. Jev matches the state against each description and never sees its position |
| JEV009 | too-few-options | info | A Choice with one option or a Score with one level gives every input the same answer |
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

Each finding links to the TypeSafe documentation page it comes from.

## Where it looks

- JSON and JSONC request bodies.
- Object literals in JavaScript and TypeScript, including requests passed
  inline to `client.systemOne(...)`.
- `noul()`, `choice()` and `score()` calls in files that use
  `@typesafe-ai/sdk`.
- Python: dicts, `Noul(...)`, `Choice(...)` and `Score(...)` from
  `typesafe_sdk` or a library that wraps it, and requests passed to
  `system_one(...)`.
- Rust: the JSON inside `json!`, structs and enum variants named for a
  question type, and `::noul(...)` style constructors.
- Go: maps with string keys, structs with a `Type` field, and structs named
  for a question type.
- A request pasted as JSON into a string, in any of these languages.
- Any other language: have your program write the request it sends to a
  `.jev.json` file and open that. Every check runs on it, and nothing in it
  is built at runtime, so nothing is skipped.
- `jev/ask` rules in an `oxlint-plugin-jev` config.

## Check a file with Jev

Rules `JEV301` to `JEV312` are not part of linting. They run only when you run
**JevLint-LE: Check This File with Jev**, or pass `--jev` on the command
line. Either sends each question in the file to Jev and asks it about problems a text pattern cannot see: options
that overlap, an option whose name contradicts its description, criteria
about the wrong thing, a Choice that should be a Score, two questions that
ask the same thing, a question that needs another question's answer.

1. Give it your key, in either of two ways. Run **JevLint-LE: Set TypeSafe
   API Key** and paste it, which stores it in your operating system keychain.
   Or type it into **Settings** under `jevlint-le.jev.apiKey`, which can only
   be set in your user settings and is left out of Settings Sync.
2. Open a file with Jev questions and run **JevLint-LE: Check This File with
   Jev**.

What to know before you run it:

- **It uses your key and your credits.** One request per question and one more
  per request body, about 800 input tokens each. At TypeSafe's published price
  that is roughly three thousandths of a cent per question.
- **Only questions are sent**: type, instructions, criteria and ids. Your
  `state` is not, unless you turn on `jevlint-le.jev.sendState`. With that on,
  a state written out in the file is sent too, and two more checks run: does
  the state hold what each question asks about, and does it carry text that
  gives orders to its reader.
- **A question with a part built at runtime is not sent.** The summary says
  how many were held back.
- **A run sends at most `jevlint-le.jev.maxCalls` requests**, 25 by default.
- **It is disabled in an untrusted workspace.** Run **Workspaces: Manage
  Workspace Trust** and trust the folder to turn it on.
- **Findings disappear when you edit the file**, because they were about the
  old text. Editing or closing the file during a check stops the check.
- **Each finding shows the probability Jev gave it.** Treat it as an argument
  with a number attached, not a verdict.

Turn on `jevlint-le.jev.confirm` and it first tells you how many requests it
will make, roughly how many tokens and what that costs, and waits for a yes.
It is off by default: running the command is the decision to send.

## Project settings

Put a `jevlint-le.json` in your project and the editor and the command line
both read it, so what you see while writing is what CI reports.

```json
{
  "rules": { "JEV004": "error", "JEV112": "off" },
  "fallbackOptions": ["other", "none", "unsure"],
  "ignore": ["JEV004:department"]
}
```

The nearest file wins, looking from the linted file upward, so a folder can
have its own. Where one applies, it replaces the `rules`, `fallbackOptions`
and `ignore` settings in the editor. If it cannot be read, nothing is linted
and the status bar says why. A key it does not know is an error, so a typo
cannot quietly leave a rule on.

To silence one finding, use the lightbulb: **Disable JEV004 for this line**
or **for this file** writes the comment for you. Strict JSON has no comments,
so there a finding is silenced with `ignore`.

## Command line

The same linting runs outside the editor, for CI and for any editor that is
not VS Code.

![The command line reporting three findings on a small request](assets/demo-cli.gif)

```bash
npx jevlint-le src/                 # a directory, searched for files it reads
npx jevlint-le request.jev.json     # one file
npx jevlint-le --format github .    # annotations on a pull request
```

It exits 0 when the run passes, 1 when a finding fails it, and 2 when it
could not do what was asked: an unknown option, a missing path, or nothing to
read. Errors always fail a run. Warnings fail it only past `--max-warnings`.

| Option | What it does |
|---|---|
| `--format <text\|json\|github>` | How findings are printed. Also `-f` |
| `--rule <CODE=level>` | Set one rule to `off`, `hint`, `info`, `warning` or `error`. A rule's name works in place of its code, and `warn` means `warning` |
| `--config <file>` | Use this settings file, and no `jevlint-le.json` found near the files. Also `-c` |
| `--max-warnings <n>` | Fail when more than `n` warnings are reported |
| `--stdin-filename <path>` | Lint standard input as if it were that file |
| `--quiet` | Print errors only |
| `--jev` | Also ask Jev about each question. Sends them to TypeSafe |
| `--jev-plan` | Say what `--jev` would send, and send nothing |
| `--jev-model <id>` | The model `--jev` asks. Default `jev-1.13.0` |
| `--jev-max-calls <n>` | The most requests `--jev` may send in the run. Default 25 |
| `--jev-send-state` | With `--jev`, also send state written out in a file |
| `--no-error-on-unmatched-pattern` | Pass when the paths hold no file to lint |
| `--mcp` | Run as an MCP server |

The summary line always says how many questions could not be read in full
and names any file skipped for its size and any folder or file it could not
read. It does not follow linked folders. It does not run the checks that ask
Jev, and it never uses the network, unless you pass `--jev`.

### Checking with Jev

`--jev` runs the checks that ask Jev itself, `JEV301` to `JEV312`, after the
linting. It is the only option that uses the network, and nothing in a
settings file can turn it on.

```bash
npx jevlint-le --jev-plan src/                    # what it would send. No key, nothing sent
TYPESAFE_API_KEY=... npx jevlint-le --jev src/    # send it
```

- The key is read from `TYPESAFE_API_KEY` and from nowhere else. It is never
  printed.
- A question with a part built at runtime is never sent. The summary counts
  the ones held back.
- State is not sent unless you add `--jev-send-state`.
- `--jev-max-calls` is a limit for the whole run. A run that needs more exits
  2, so a job cannot pass after checking part of a project.
- A rejected key, a failed request or a run you stop also exits 2, and says
  how many requests were answered of how many were planned.
- These findings are warnings or less by default, so they fail a run only
  when `--rule` raises one or `--max-warnings` is passed.

## For AI agents

The same program is an MCP server, so an agent that writes Jev questions can
lint what it wrote and fix it before you see it.

Agents running inside VS Code get it with no setup: the extension offers the
server to the editor, which starts it when an agent calls a tool. For any
other client, point it at the program:

```json
{
  "mcpServers": {
    "jevlint-le": { "command": "npx", "args": ["-y", "jevlint-le", "--mcp"] }
  }
}
```

It offers three tools: `lint_text` for a request or source code passed as
text, `lint_paths` for files on disk, and `list_rules`. It never uses the
network, and it does not run the checks that ask Jev.

## Probe a question

Put the cursor in a question and run **JevLint-LE: Probe the Jev Question at
the Cursor**. It sends that question against the state written beside it,
three times as written and then with the layout changed: options reversed,
option names hidden, levels reversed, criteria removed. A report opens showing
whether the answer moved.

If the answer changes when only the order of the options changes, the
question is not deciding it. If three identical requests disagree, the input
is too close to call.

It needs the state written out in the file, it sends that state, and it costs
five or six requests.

Nothing else in this extension uses the network. On the command line, only
`--jev` does.

## What it will not tell you

- **Whether a well-formed question is right on your data.** That needs labeled
  examples and calls to Jev.
- **Anything about a value it cannot see.** A question built from variables is
  reported as unreadable and counted in the status bar. A file is never shown
  as clean while part of it went unread.
- **Everything about wording.** `JEV101` to `JEV112` are heuristics over
  English text, and most are off. Each default follows from running a badly
  written question and its fixed version against Jev: a rule stays on only
  where the bad wording cost answers or confidence. Seven that describe
  failure modes in TypeSafe's docs did not fail on `jev-1.13.0` in those runs
  or were wrong too often on public code. Switch any of them on in
  `jevlint-le.rules`.
- **Anything about a question that is not in English.**
- **What a lone object lacks.** A `{ type, instructions }` outside a
  `questions` map may be a template or half of a builder, so a missing
  `criteria` is only reported inside a request.

`JEV004` is informational because the advice behind it is conditional: add a
fallback when the options might not cover every input. It fires on 9 of the 11
Choice examples in TypeSafe's own docs. If your options are exhaustive, turn it
off for that question.

## Suppressing a finding

In code:

```ts
// jevlint-le-disable-next-line JEV004
const side = { type: 'choice', instructions: 'Heads or tails?', criteria: { heads: null, tails: null } };
```

`jevlint-le-disable-line` covers the same line and `jevlint-le-disable` the whole file.
Leave the code off to silence every rule.

JSON has no comments, so use the setting:

```json
{ "jevlint-le.ignore": ["JEV004:side"] }
```

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `jevlint-le.rules` | `{}` | Severity per rule: `off`, `hint`, `info`, `warning`, `error` |
| `jevlint-le.fallbackOptions` | `other`, `none`, `none of the above`, `unknown`, `unclear`, `neither`, `not stated`, `not applicable`, `n/a` | Option names that satisfy `JEV004` |
| `jevlint-le.ignore` | `[]` | `CODE:questionId` entries to drop |
| `jevlint-le.include` | JSON, JS and TS files | Files the workspace command lints |
| `jevlint-le.exclude` | `node_modules` and build output | Files the workspace command skips |
| `jevlint-le.maxFileSizeBytes` | `1000000` | Larger files are reported as skipped |
| `jevlint-le.notificationsLevel` | `important` | How much is said in notifications. `all` adds a summary after each command, and `silent` shows a message only when a command could not run. Findings always show in the editor |
| `jevlint-le.jev.model` | `jev-1.13.0` | The model **Check This File with Jev** asks. Pinned to the version its checks were calibrated on |
| `jevlint-le.jev.maxCalls` | `25` | The most requests one check may send |
| `jevlint-le.jev.sendState` | `false` | Also send a state written in the file, so Jev can check it |
| `jevlint-le.jev.confirm` | `false` | Before a paid command sends anything, show what it will send and cost, and wait for a yes |
| `jevlint-le.jev.apiKey` | empty | Your TypeSafe key, if you would rather type it here than use the keychain. User settings only |

## Development

```bash
bun install
bun run typecheck && bun run lint && bun run test
bun run build
bun run test:integration   # real VS Code against samples/
bun run package            # release/jevlint-le-<version>.vsix
bun run test:e2e-vsix      # the packaged VSIX in a clean profile
```

`AGENTS.md` is the engineering standard. `SPEC.md` is what the product is and
what is planned. `samples/` is a workspace with planted mistakes, used by
`bun run test:integration`, which drives a real VS Code.

## License

MIT
