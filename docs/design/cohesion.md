# Cohesion: making Vyre one system

Status: proposed (cohesion team, 2026-09-27). Owners named per item. Nothing here moves a feature
out of its team: cohesion writes the shared contracts, the small glue modules behind them, and the
tests that keep surfaces from drifting apart again.

## The problem in one paragraph

Each module is good on its own, and each surface rebuilds the parts it needs. The Capsule has its own
intent rules, model names, command table and memory answer. The Deck has two model lists and a stale
copy of the passkey tool list. Five account lists have five shapes, and nothing can answer "which
accounts can send email". Nobody knows what is on screen or which project the user is in, so every
surface guesses. There is no suggest tool, no notify contract and no single "waiting on you" count.
The fix is a handful of shared lookups that every surface calls, so a thing learned or connected once
shows up everywhere at once.

## Principles

1. One owner per fact. A surface never keeps a copy of a list another module owns (models, commands,
   accounts, tool policies, tokens). It reads the registry and follows the change event.
2. Aggregators are glue, not features. A glue module (context, connections, suggest, needs) owns no
   data. It fans out to `<module>.<verb>` providers that modules declare in their manifest, under a
   deadline, and merges the answers. Switch it off and each provider still works on its own.
3. Every change has an event, and the event carries enough to act on (the new value, or the row).
4. The same input gets the same answer on every surface. Routing, ranking and wording live on the box.

## Ranked opportunities

Ranked by how much each one makes Vyre feel like one system in daily use. Effort: S (a day), M (a few
days across two or three teams), L (a week or more, several teams).

| # | Opportunity | Owners | Effort |
|---|---|---|---|
| 1 | Context now: screen, project, thread, device | cohesion (glue), capsule-pro, sessions, memory-iq, chat | M |
| 2 | Connections for a capability ("send an email" offers every account) | cohesion (glue), connectors, vault, capsule-pro, pwa | M |
| 3 | Suggest: one predictive-text tool for Capsule, chat and phone | cohesion (glue), memory-iq, capsule-pro, chat, native-core | L |
| 4 | One ask path: the same question gets the same answer everywhere | memory-iq, sessions, capsule-pro, chat | M |
| 5 | `vyre` commands everywhere, rendered in the Capsule | platform, polish-cli, capsule-pro, chat | M |
| 6 | Every key set up once, through the vault | vault, connectors, polish-cli, capsule-pro, pwa | M |
| 7 | One "waiting on you" and one notice path | cohesion (glue), pwa, capsule-pro, mobile, polish-cli | M |
| 8 | The hub read live by every surface (no hardcoded models or tokens) | native-core, platform, app-design, capsule-pro, mobile, sessions | M |
| 9 | One live catalog of projects, threads and agents | sessions, capsule-pro, chat, mobile | S |
| 10 | Memory learns from the whole system | memory-iq, connectors, sessions | M |
| 11 | One devices list and one pairing story | relay, vault, pwa, e2e | L |
| 12 | Sessions start knowing today (agenda, accounts, open asks) | sessions, memory-iq | S |
| 13 | One card set for asks, approvals and plans | app-design, chat, pwa, mobile, capsule-pro | M |
| 14 | Event vocabulary and a live event catalog | platform, cohesion | S |
| 15 | Shrink the boundaries allowlist | ci, owners of each edge | M |

### 1. Context now

**What connects:** the Capsule's view of the Mac (front app, window, URL, selection through
`screen.context`), the project a folder or document belongs to (`projects.of`), the thread in focus
(`threads.live`, `lease.changed`), and the device in use (`push.seen`).
**Today:** nobody owns it. The Capsule runs every ask in a scratch folder, chat never defaults the
project, `harness.enrich` and memory have no focus signal, and push guesses the device.
**Contract (new):** `context.now {parts?}` returns `{project, cwd, thread, surface, device, app,
window, url, selection?, at}`; `context.report {…}` is how a surface says what it sees (the Capsule on
app switch, chat on thread open, the phone on foreground); `context.changed {changed: [...], …}` fires
on a real change, debounced to one per second. Screen text is never stored or broadcast: `context.now
{parts:["screen"]}` pulls it live from `screen.context` on the device that owns the screen, and
`secure`/`blind` redaction carries through.
**Consumers:** Capsule (default project, ask `cwd`, "about this page" without a command), chat (new
thread lands in the right project), `harness.enrich` and `iq.ask` (scope and boost), push (ring the
device in use), status line.
**Value:** the user stops telling Vyre where they are.

### 2. Connections for a capability

**What connects:** `google.accounts`, `mcp.servers`, gate senders, `apps.targets`, voice providers
and vault items.
**Today:** five lists, five shapes, no capability model. `forWrite` throws "say which account";
Slack's server is guessed from tool names; nothing listens to `mcp.added` or `vault.granted`; Gmail
can be sent two ways (gate's static-token `gmail` sender and google's OAuth sender).
**Contract (new):** each owner declares `does.connections: "<module>.connections"` returning rows
`{id, module, provider, account, label, capabilities: ["mail.send", "calendar.write", "chat.post",
…], state, needs?}`. Glue `connections.for {capability}` fans out and returns rows ranked by
default, last used and project; `connections.list` returns all. One event family:
`connection.added`, `connection.removed`, `connection.changed`, emitted by the glue when an owner's
own event (`google.connected`, `mcp.added`, `vault.granted`, …) lands, so consumers follow one family.
Capability names are a short fixed vocabulary in the contract doc.
**Consumers:** Capsule ("send an email" lists alex@harlowlegal and alex@northwind), gate
(`gate.route` names real options), apps (Slack server choice), Deck Connections, `vyre connect list`.
**Value:** connect an account once and every surface offers it.

### 3. Suggest

**What connects:** personal aliases and entities (memory-iq), graph labels, recall (a new prefix
mode), projects, threads, agents, planner items, commands (item 5), connections (item 2), files.
**Today:** no tool. The Capsule ranks its own `@` list, chat has `/` and `@file` only, the phone has
less.
**Contract (new):** `suggest.query {text, cursor, surface, context?, limit?}` returns `[{kind,
label, insert, detail?, action?, source, score}]` with `kind` in mention, command, account, entity,
phrase, file, time. Providers declare `does.suggest: "<module>.suggest"` and get a 25 ms deadline;
late providers are dropped from that keystroke, never waited on. Phrase completion ("send an email
to jun" becomes "…to juno") comes from memory entities plus connections, not a model call.
`suggest.picked {kind, source, id}` teaches ranking. IQ answers are a separate slower lane: the
surface may call `iq.ask` once the user pauses, never per keystroke.
**Consumers:** Capsule input, chat composer (Deck, PWA, Expo through chat-core), CLI prompt later.
**Value:** typing feels like Vyre already knows the user's world.

### 4. One ask path

**Today:** the Capsule has its own question rules and hardcoded `haiku`/`sonnet`, and builds its own
memory answer in `Said.swift`; the Deck calls `agents.ask`. The user's "wife's name" bug (a test
fixture answered, differently each time) came from this split.
**Contract:** one box route (`agents.ask` or `iq.ask` with `surface`) decides question vs task and
the model through `sessions.models.resolve {purpose}`. `memory.answer`, then `iq.ask`, is the one
memory answer; surfaces render, they do not rank. Personal facts only from the user's own words.
**Owners:** memory-iq (answer), sessions (route, prompt, temperature 0), capsule-pro (retire
`Said.swift` and the local rules), chat.

### 5. Commands everywhere

**Today:** five command grammars: CLI files, Capsule `SystemCommands`, sight's hardcoded commands,
chat's `/` list, Deck Find. `shows.cli` in manifests is read by nothing.
**Contract:** platform's `does.commands {verb, tool, summary, args?}` (ADR 0033) is the one source.
Add `commands.list {surface}` (reads `GET /v1/modules`) and a result shape `{view: "table" | "text" |
"card", title, rows | text, actions?}` that a tool returns when called with `render: true`, so the
Capsule and chat draw `vyre` output natively instead of printing terminal text.
**Owners:** platform (manifest field), polish-cli (dispatcher, `--json` for the seven commands that
lack it), capsule-pro and chat (render).

### 6. Every key set up once

**Today:** `vyre voice key`, `vyre vault grant`, onboard's Claude step, connectors' `--client`, APNs
keys and the tailnet auth key are six flows for one act. `names` reads its token from the
environment before the vault. Rotated OAuth refresh tokens are never written back.
**Contract:** a module that lacks a declared `needs.vault` item emits `credential.needed {module,
item, why, kind}` (vault owns it); every surface shows one setup sheet that calls `vault.put` plus
the grant in one step; `vault.needs` lists what is missing. Connections rows (item 2) carry `needs`
so the Capsule can say "Connect Deepgram to talk" inline.
**Owners:** vault (event, sheet contract), connectors (write back refresh tokens, retire gate's
static Gmail sender), polish-cli (one `vyre key` command over the same tool), capsule-pro and pwa.

### 7. One "waiting on you" and one notice path

**Today:** push has a fixed `NOTES` map, the Capsule posts its own banners, planner has its own, the
Deck has two toasts, and the status line counts needs separately from push. A phone can ring twice.
**Contract (new):** glue `needs.list` merges `threads.asks`, `gate.held`, `planner.ringing` and
pending pairings into one row shape with one count, and `needs.changed` fires when the count moves.
Modules declare notice kinds in `shows.notices` instead of push editing a map; push, the Capsule, the
Deck and the phone all render from `needs.list` and resolve by id, so answering on one device clears
the others.
**Owners:** cohesion (glue), pwa (push, Deck), capsule-pro, mobile, polish-cli (status line).

### 8. The hub read live everywhere

In flight with native-core (central hub, ADR 0035) and platform (decision 6). Cohesion's part:
`settings.changed` carries the resolved value; a contract test fails if any surface ships a
hardcoded model list, effort list, tool-policy list (`SESSIONABLE`, `HUMAN_ONLY`) or token file not
generated from the hub; sessions reads `settings.resolve` at thread start.

### 9. One live catalog

`projects.catalog` grows to return projects, threads (with `status`) and agents in one call, and a
`catalog.changed` event (or the existing `project.*`, `thread.started` family, documented as the
refresh set). Fixes the Capsule's per-project N+1 and its second copy in sight; feeds suggest.

### 10. Memory learns from the whole system

Memory listens only to thread and session events. Add listens and `teaches` for `planner.*` (people
and places), `gate.released` (who the user writes to), `connection.added` (the user's own accounts),
and calendar attendees, all as the user's own words or first-party records, never tool or test text.

### 11 to 15, in short

- **Devices:** six lists (`vault.device.*`, `relay.devices.list`, `presence.person.sessions`,
  `push.devices`, `onboard.status` peers, `link.peers`). A `devices.list` glue with one row per real
  device and its capabilities, so Settings shows one list and pairing is one story.
- **Sessions start knowing today:** `harness.brief` adds the agenda (`planner.agenda`), open needs
  (item 7) and the project's connections (item 2), inside its 600-token budget.
- **One card set:** ask, approval and plan cards come from the design system specs, built once in
  chat-core for web and Expo, mirrored in Swift from the same spec.
- **Events:** a `events.catalog` tool from the manifests; fix singular vs plural nouns (`file.*` vs
  `files.*`, `computer.*` vs `computers.*`) with aliases for a release; document run-time names.
- **Boundaries:** 26 frozen edges; most are `lib` moves (tailscale, transport, auth).

## Cross-cutting contracts (cohesion writes these)

| Contract | Tool(s) | Event | Provider convention |
|---|---|---|---|
| Context now | `context.now`, `context.report` | `context.changed` | surfaces report; `screen.context` pulled live |
| Connections | `connections.for`, `connections.list` | `connection.added/removed/changed` | `does.connections: "<m>.connections"` |
| Suggest | `suggest.query`, `suggest.picked` | none | `does.suggest: "<m>.suggest"`, 25 ms deadline |
| Needs | `needs.list`, `needs.resolve` | `needs.changed` | owners keep their tools; glue merges |
| Credentials | `vault.needs` | `credential.needed` | `needs.vault` in the manifest |
| Commands | `commands.list` | `commands.changed` | `does.commands` (ADR 0033) |

Each glue module ships with its manifest, tests with fake providers, a work note, and switches off
cleanly. The provider fields go through platform so the manifest schema stays one document.

## Needs an ADR number

One ADR for the four glue contracts (context, connections, suggest, needs). Number from the lead.
