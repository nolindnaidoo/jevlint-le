@AGENTS.md

# CLAUDE.md

[AGENTS.md](AGENTS.md) above is the technical source of truth for this repo.
Read it before writing code.

| Question | File |
|---|---|
| How should this code be written, and what must stay true? | [AGENTS.md](AGENTS.md) |
| What is the product, and what is planned? | [SPEC.md](SPEC.md) |
| What does the user see? | [README.md](README.md) |
| What changed? | [CHANGELOG.md](CHANGELOG.md) |

## Gates

```bash
bun run typecheck && bun run lint && bun run test
```

Before a release, also `bun run test:cli`, `bun run test:integration`,
`bun run package` and `bun run test:e2e-vsix`. The last is the only test of
the artifact users install.
