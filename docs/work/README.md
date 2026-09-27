# Workstreams

Each workstream in section 13 of [`../SPEC.md`](../SPEC.md) keeps one file here, named after
it (`vault.md`, `capsule.md`, ...). The session that owns the workstream updates it at the end
of every working stretch. The main session reads these files to see where everything stands.

## Template

```markdown
# <stream>

Branch: work/<stream> · Worktree: ../vyre-<stream> · Owner session: <name>

## Done
- <what landed, with the commit>

## Doing
- <the one thing in progress>

## Next
- <ordered>

## Needs from others
- <stream>: <the tool, event or change needed, and why>

## Changed contracts
- <any change to a manifest, tool schema, event or API route that others use>
```

## ADR numbers

- 0019: docs (the docs.vyre.run site).

## Rules

- Touch only the folders your workstream owns. Use another stream's work through `ctx` or the
  API, never by importing its files.
- A contract change (tool input, event payload, route) goes in "Changed contracts" before it
  merges, so dependents see it.
- Merge to `main` only with the full suite green: `npm test`.

## ADR numbers

Claim the next number here before writing the ADR, so two workstreams never take the same one.

| ADR | Workstream | Title |
|---|---|---|
| 0013 | box | box sessions |
| 0014 | tailnet | tailnet |
| 0016 | connectors | Connectors: the MCP hub and native accounts |
| 0020 | cc-plugin | Vyre as an installable Claude Code plugin, and the status line |
| 0024 | chat | Chat: new sessions, the box's folders, a terminal in the browser, and questions |
