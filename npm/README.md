# jevlint-le

Lints the questions you write for TypeSafe's Jev model, before they are sent.
Jev answers a badly written question as confidently as a good one, so the
mistake shows up later as wrong answers. This finds it in the code.

One package, two ways to run it. Neither needs an API key or uses the network,
unless you pass `--jev` to the command line.

## Command line

```bash
npx jevlint-le src/                 # a directory, searched for files it reads
npx jevlint-le request.jev.json     # one file
npx jevlint-le --format github .    # annotations on a pull request
```

It reads JSON, JavaScript, TypeScript, Python, Rust and Go. For any other
language, have your program write the request it sends to a `.jev.json` file
and lint that.

It exits 0 when the run passes, 1 when a finding fails it, and 2 when it
could not do what was asked. Errors always fail a run. Warnings fail it only
past `--max-warnings`.

| Option | What it does |
|---|---|
| `--format <stylish\|compact\|json\|github>` | How findings are printed. `stylish` groups them by file and is the default. `compact` is one per line as `path:line:column`. Also `-f` |
| `--rule <CODE=level>` | Set one rule to `off`, `hint`, `info`, `warning` or `error`. A rule's name works in place of its code, and `warn` means `warning` |
| `--config <file>` | Use this settings file, and no `jevlint-le.json` found near the files. Also `-c` |
| `--max-warnings <n>` | Fail when more than `n` warnings are reported |
| `--stdin-filename <path>` | Lint standard input as if it were that file |
| `--fix` | Write the fixes that only mend what the API would refuse |
| `--quiet` | Print errors only |
| `--jev` | Also ask Jev about each question. Sends them to TypeSafe |
| `--jev-plan` | Say what `--jev` would send, and send nothing |
| `--jev-model <id>` | The model `--jev` asks. Default `jev-1.13.0` |
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

For an AI agent that writes Jev questions. It can lint what it wrote and fix
it before you see it.

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

## What it does not do

The MCP server never calls Jev. The probe that re-sends one question with its
layout changed is in the VS Code extension of the same name.
