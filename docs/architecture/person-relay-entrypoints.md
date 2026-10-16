# Person relay entry points

Standing rules (owner):

- Fix the **class everywhere** — one shared implementation in [`lib/person-relay.js`](../../lib/person-relay.js), every entry point wired through it, and **table-driven tests** derived from [`lib/person-relay-entrypoints.js`](../../lib/person-relay-entrypoints.js) (not hand-maintained surface lists).
- **Agent-agnostic** — slash, member relay, and isolation live tests must behave the same for every registered session adapter. Use [`core/sessions/testing/fake-agent-harness.js`](../../core/sessions/testing/fake-agent-harness.js) (`FAKE_SESSION_PROVIDERS`: **claude**, **grok**, **codex**); do not wire tests through Claude-only env vars.

## Shared binding

- `personCallOpts(caller, meta)` — `{ as, token?, kernelFacts?, person? }` for nested `ctx.call`
- `relayPersonTool(ctx, caller, meta, tool, input)` — composer slash relays
- `core/modules/index.js` — `CALL_AS` merges `currentCall()` for any person-surface `{ as }`

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

Harness: [`core/person-scope/member-relay-harness.js`](../../core/person-scope/member-relay-harness.js).

## Primary surfaces

| id | Surface tool | Nested person-scoped tools |
|----|----------------|----------------------------|
| `composer.slash` | `threads.slash` | `planner.add`, `recall.search`, `threads.remember`, `threads.shell`, … |
| `composer.send` | `threads.send` | `mentions.search`, `mentions.resolve`, `vault.mention.resolve` |
| `composer.edit-queued` | `threads.edit` | same as send |
| `stream.group-slash` | `threads.slash` | same as composer slash |
| `mcp.threads_slash` | `threads.slash` | same as composer slash |
| `stream.stream.send` | `stream.send` / `stream.send-group` | ingress targets |

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

Person hops via `{ relay: true }` (see `core/modules/index.js`): spaces, memory, work, publish, previews, providers, vault, term, mcp, appmods, import — each to a fixed nested tool prefix list. Documented in `lib/person-relay-report.js` (`RELAY_ALLOWED_SUMMARY`).

## Out of scope for the entry-point list

- Mac/box link writes (`link.macs.call`, `as: "person"`)
- MCP thread/agent labels without a person turn
- Registry `callers` gates (separate from relay opts)
