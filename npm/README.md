# jevlint-le

Lints the questions you write for TypeSafe's Jev model, before they are sent.
Jev answers a badly written question as confidently as a good one, so the
mistake shows up later as wrong answers. This finds it in the code.

One package, two ways to run it. Neither needs an API key or uses the network.

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
| `--format <text\|json\|github>` | How findings are printed |
| `--rule <CODE=level>` | Set one rule to `off`, `hint`, `info`, `warning` or `error` |
| `--config <file>` | Use this settings file, and no `jevlint-le.json` found near the files |
| `--max-warnings <n>` | Fail when more than `n` warnings are reported |
| `--stdin-filename <path>` | Lint standard input as if it were that file |
| `--quiet` | Print errors only |
| `--mcp` | Run as an MCP server |

## Settings

A `jevlint-le.json` in your project sets rule levels, and the VS Code
extension reads the same file, so the editor and CI agree.

```json
{
  "rules": { "JEV004": "error", "JEV112": "off" },
  "ignore": ["JEV004:department"]
}
```

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

It does not call Jev. The checks that ask Jev itself about a question, and the
probe that re-sends one, are in the VS Code extension of the same name.
