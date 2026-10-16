---
title: Person relay entry points
summary: How composer, stream, and MCP surfaces relay a person's line into person-scoped kernel tools, with one shared implementation and table-driven tests.
audience: builders
owner: docs
status: stable
---

# Person relay entry points

Standing rules (owner):

- Fix the **class everywhere**: one shared implementation in [`lib/person-relay.js`](../../lib/person-relay.js), every entry point wired through it, and **table-driven tests** derived from [`lib/person-relay-entrypoints.js`](../../lib/person-relay-entrypoints.js) (not hand-maintained surface lists).
- **Agent-agnostic**: slash, member relay, and isolation live tests must behave the same for every registered session adapter. Use [`core/sessions/testing/fake-agent-harness.js`](../../core/sessions/testing/fake-agent-harness.js) (`FAKE_SESSION_PROVIDERS`: **claude**, **grok**, **codex**); do not wire tests through Claude-only env vars.

## Shared binding

- `personCallOpts(caller, meta)` gives `{ as, token?, kernelFacts?, person? }` for nested `ctx.call`
- `relayPersonTool(ctx, caller, meta, tool, input)` handles composer slash relays
- `core/modules/index.js` merges `CALL_AS` from `currentCall()` for any person-surface `{ as }`

## Generated entry-point table

The canonical list is built at runtime:

```js
import { listAllPersonRelayEntryPoints } from "../../lib/person-relay-entrypoints.js";
import { personRelayReportMarkdown } from "../../lib/person-relay-report.js";
// personRelayReportMarkdown(registry) → markdown for docs/PRs
```

Live isolation tests (parametrized over **claude**, **grok**, **codex**):

- [`core/person-scope/member-relay-entrypoints.test.js`](../../core/person-scope/member-relay-entrypoints.test.js)
- [`core/switchboard/composer-slash-member-live.test.js`](../../core/switchboard/composer-slash-member-live.test.js)

Harness: [`core/person-scope/member-relay-harness.js`](../../core/person-scope/member-relay-harness.js). `/find` live cases boot recall via [`core/sessions/testing/recall-live.js`](../../core/sessions/testing/recall-live.js) (Node **22.16+** for FTS5 in `node:sqlite`).

## Primary surfaces

| Entry id (from code) | Surface tool | Nested person-scoped tools |
|----------------------|--------------|----------------------------|
| `composer.slash` | `threads.slash` | `planner.add`, `recall.search`, `threads.remember`, `threads.shell`, … |
| `composer.send` | `threads.send` | `mentions.search`, `mentions.resolve`, `vault.mention.resolve` |
| `composer.edit-queued` | `threads.edit` | same as send |
| stream / MCP slash ids | `threads.slash` | same as composer slash (see generated table) |
| stream send ids | `stream.send` when registered | ingress targets from `ingressRelayTargets()` |

Exact stream and MCP entry ids are derived in `listPersonRelayEntryPoints()`; run `personRelayReportMarkdown(registry)` on a live box rather than duplicating them here.

## Auxiliary relays

| id | Tool | Notes |
|----|------|--------|
| `agents.ask` | `agents.ask` | → `threads.send`, `threads.release` as asking person |
| `mentions.search` | `mentions.search` | providers run as caller |
| `mentions.resolve` | `mentions.resolve` | → `vault.mention.resolve` |
| `views.*` | `capsule.*` / `views.*` | first-party module tools as person (`lib/views/engine.js`) |
| `connectors.declare` | `connectors.declare` | → `vault.put` |
| `appmods.install` | `appmods.install` | → `connectors.connection.create` |

## Module `RELAY_ALLOWED`

Person hops via `{ relay: true }` (see `core/modules/index.js`): spaces, memory, work, publish, previews, providers, vault, term, mcp, appmods, import, each to a fixed nested tool prefix list. Documented in `lib/person-relay-report.js` (`RELAY_ALLOWED_SUMMARY`).

## Out of scope for the entry-point list

- Mac/box link writes (`link.macs.call`, `as: "person"`)
- MCP thread/agent labels without a person turn
- Registry `callers` gates (separate from relay opts)
