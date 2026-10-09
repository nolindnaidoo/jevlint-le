# jevlint-le

Lints the questions you write for TypeSafe's Jev model and for OpenAI's
Decisions API (`gpt-6-luna`), before they are sent. Either model answers a
badly written question as confidently as a good one, so the mistake shows up
later as wrong answers. This finds it in the code.

The rules and their defaults were set by measuring what each defect costs
Jev. Luna has not been measured yet, so on a Luna question they are the same
rules with Jev's defaults.

One package: a command line, an MCP server and a library. None needs an API
key or uses the network, unless you pass `--jev` to the command line.

## Command line

```bash
npx jevlint-le src/                 # a directory, searched for files it reads
npx jevlint-le request.jev.json     # one file
npx jevlint-le --format github .    # annotations on a pull request
```

It reads JSON, JavaScript, TypeScript, Python, Rust and Go, in TypeSafe's
request shape and in OpenAI's Decisions API shape. For any other language,
have your program write the request it sends to a `.jev.json` file and lint
that.

It exits 0 when the run passes, 1 when a finding fails it, and 2 when it
could not do what was asked. Errors always fail a run. Warnings fail it only
past `--max-warnings`.

| Option | What it does |
|---|---|
| `--format <stylish\|compact\|json\|github\|sarif\|junit>` | How findings are printed. `stylish` groups them by file and is the default. `compact` is one per line as `path:line:column`. `sarif` is for code scanning and `junit` for test reporters. Also `-f` |
| `--rule <CODE=level>` | Set one rule to `off`, `hint`, `info`, `warning` or `error`. A rule's name works in place of its code, and `warn` means `warning` |
| `--config <file>` | Use this settings file, and no `jevlint-le.json` found near the files. Also `-c` |
| `--max-warnings <n>` | Fail when more than `n` warnings are reported |
| `--stdin-filename <path>` | Lint standard input as if it were that file |
| `--fix` | Write the fixes that only mend what the API would refuse |
| `--quiet` | Print errors only |
| `--jev` | Also ask the model about each question. Sends them to TypeSafe with `TYPESAFE_API_KEY`, or with `--jev-model gpt-6-luna` to OpenAI with `OPENAI_API_KEY` |
| `--jev-plan` | Say what `--jev` would send, and send nothing |
| `--jev-model <id>` | The model `--jev` asks: a Jev version, or `gpt-6-luna` for OpenAI's Decisions API. Default `jev-1.13.0` |
| `--jev-max-calls <n>` | The most requests `--jev` may send in the run. Default 25 |
| `--jev-send-state` | With `--jev`, also send state written out in a file |
| `--color`, `--no-color` | Colour the default format, or do not. Without either it is coloured in a terminal, unless `NO_COLOR` is set |
| `--no-error-on-unmatched-pattern` | Pass when the paths hold no file to lint |
| `--mcp` | Run as an MCP server |

### Checking with Jev

`--jev` runs the checks that ask Jev itself, `JEV301` to `JEV312`, after the
linting. It is the only option that uses the network, and nothing in a
settings file can turn it on.

```bash
npx jevlint-le --jev-plan src/                    # what it would send. No key, nothing sent
TYPESAFE_API_KEY=... npx jevlint-le --jev src/    # send it
```

- The key is read from `TYPESAFE_API_KEY` and from nowhere else. It is never
  printed. With `--jev-model gpt-6-luna` the checks go to OpenAI's Decisions
  API instead, with the key in `OPENAI_API_KEY`, and each finding says that
  its cutoff was set on Jev.
- A question with a part built at runtime is never sent. The summary counts
  the ones held back.
- State is not sent unless you add `--jev-send-state`.
- `--jev-max-calls` is a limit for the whole run. A run that needs more exits
  2, so a job cannot pass after checking part of a project.
- A rejected key, a failed request or a run you stop also exits 2, and says
  how many requests were answered of how many were planned.
- These findings are warnings or less by default, so they fail a run only
  when `--rule` raises one or `--max-warnings` is passed.

## In the editor

Installed in a project's dev dependencies, this package is also what the
[JevLint-LE extension](https://marketplace.visualstudio.com/items?itemName=nolindnaidoo.jevlint-le)
lints with in VS Code, so the editor and CI report the same findings from the
same version. It needs 0.3.0 or newer and a trusted workspace.

## Settings

A `jevlint-le.json` in your project sets rule levels, and the VS Code
extension reads the same file, so the editor and CI agree.

```json
{
  "rules": { "JEV004": "error", "JEV112": "off" },
  "ignore": ["JEV004:department"],
  "exclude": ["fixtures", "**/*.generated.ts"]
}
```

`exclude` lists files and folders not to lint, relative to the settings file.

The nearest one to each file is used, looking no higher than the directory
the command is run in.

## MCP server

For an AI agent that writes Jev or OpenAI Decisions questions. It can lint
what it wrote and fix it before you see it. The tool descriptions and the
server's instructions name both vendors, so an agent knows to call it for
either shape.

```json
{
  "mcpServers": {
    "jevlint-le": { "command": "npx", "args": ["-y", "jevlint-le", "--mcp"] }
  }
}
```

| Tool | What it does |
|---|---|
| `lint_text` | Lints a request body or source code passed as text |
| `lint_paths` | Lints files or directories on disk |
| `list_rules` | Lists every rule with its default level and docs link |

## As a library

```js
const jevlint = require('jevlint-le');

const { findings } = jevlint.lint(text, options, 'js');
const { text: mended, fixed } = jevlint.fix(text, options, 'js');
```

`lint` and `fix` are pure: no filesystem, no network. `options` takes the
same `rules`, `fallbackOptions` and `ignore` as `jevlint-le.json`. The third
argument is the syntax, one of `syntaxes`: `js` for JSON, JavaScript and
TypeScript, then `python`, `rust` and `go`. Any other value throws, naming
those four. `rules` lists every rule
with its name, default level and pages, and `api` is the number an editor
checks before loading a copy. Names here are only added to. A change that
removes or alters one raises `api`.

## What it does not do

The MCP server never calls Jev. The probe that re-sends one question with its
layout changed is in the VS Code extension of the same name.
