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
| 0015 | capsule-sight | screen context and computer use on the Mac |
| 0016 | connectors | Connectors: the MCP hub and native accounts |
| 0017 | capsule-pro | native Capsule (was claimed as 0015 here, which capsule-sight had written) |
| 0020 | cc-plugin | Vyre as an installable Claude Code plugin, and the status line |
| 0018 | mobile | The phone apps: native iOS and Android on the box's API |
| 0022 | capsule-apps | @App targets: every Mac app from the Capsule |
| 0023 | memory-iq | Personal facts and memory.answer |
| 0024 | chat | Chat: new sessions, the box's folders, a terminal in the browser, and questions |
| 0025 | planner | The planner: time, alarms, reminders, todos, notes and a calendar on the box |
| 0026 | relay | End-to-end encrypted relay with QR pairing |
| 0027 | mobile | One app: the phone, the box's web app and app.vyre.run from one Expo codebase |
| 0028 | vault-next | Vault: import, agent logins, rotation and autofill on every device |
| 0029 | resilience | The resilience contract: every surface survives network outages |
| 0030 | sessions | Vyre-owned sessions and the provider router |
| 0031 | teammates | Project teammates |
| 0032 | e2e | The person and the device |
| 0033 | platform | Hackable Vyre: the module API, extension points, user modules and updates |
| 0034 | memory-iq | Vyre IQ: cited answers from every session, fact and the graph |
| 0035 | native-core | The settings hub: one file, four levels, read live by every surface |
| 0036 | cohesion | One system |
| 0039 | anywhere | Vyre anywhere: role as a choice, moving to a server |
| 0040 | e2e | vyre-core, a trusted root split from vyred |
| 0045 | tailnet | Scan-to-pair (Wink): relay.pair.ticket, a signed pairing ticket the Vyre code can carry (renumbered from this table's stale "0037"; the live registry is team/ADR-NUMBERS.md, outside git) |
| 0046 | tailnet | The relay introduces, Tailscale carries: auth-key auto-join (renumbered from this table's stale "0038", which was relay-first-everywhere, now shelved) |
