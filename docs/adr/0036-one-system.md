---
title: "ADR 0036: One system"
summary: Four small glue modules (sight, context, suggest, waiting) give every surface the same answer to what is on a screen, where the user is, what they are typing toward and what is waiting on them. They own no data; they read other modules through the registry.
audience: builders, agents
owner: cohesion
status: draft
---

# ADR 0036: One system

Status: accepted by the lead, 27 Sep 2026 · Workstream: cohesion · Related: ADR 0015 (screen
context on the Mac), ADR 0016 (connectors), ADR 0028 (vault v2), ADR 0033 (hackable Vyre),
ADR 0034 (Vyre IQ), ADR 0035 (the settings hub) · Map: docs/design/cohesion.md

## Context

Each surface rebuilt what it needed. The Capsule has its own intent rules, model names, command
table and memory answer. The Deck keeps a stale copy of the passkey tool list. Nothing knows the
current project or what is on screen, so every surface guesses. What an agent does on its
computer reaches no view: `desktop.acted` and `chrome.acted` have no listener, and the Glass log
shows only take-overs. There is no suggest tool and no single "waiting on you" count.

## Decision

Four glue modules. (The fourth is `waiting`, not `needs`, because `needs` is already a manifest
verb.) Each one owns no data of another module, reads others only through tools and
events, ships with fakes in its tests, and can be switched off without breaking anything else.
Where a team already owns the answer (connections and credentials belong to the vault, ADR 0028
decision 9), cohesion does not build a second one.

### 1. sight: one screen service on both sides

The same contract describes the user's Mac screen and an agent's computer. A target is `mac` (the
Mac this vyred runs on) or `agent:<name>` (a computer in Glass).

- `sight.targets {}` returns `[{target, kind: "mac"|"agent", label, live, holder?}]`. On a Mac, `mac`
  is listed when the `screen` module runs. On the box, one row per computer from `computers.list`.
- `sight.now {target, parts?}` returns `{target, kind, agent?, app, window, url, step, holder?,
  at}` where `step` is the last step (below). `parts: ["text"]` adds `text` and `focused` for `mac`
  only, read live from `screen.context`; `parts: ["controls"]` adds the control list from
  `hands-desktop.tree` or `chrome.snapshot` for an agent.
- `sight.watch {target}` returns the frame stream for an agent (the `computers.watch` ticket). For
  `mac` it answers `local_only`: the Mac's pixels never leave the Mac.
- `sight.steps {target?, thread?, limit?}` returns recent steps, newest first.
- Event `sight.stepped {target, agent?, thread?, call?, action, summary, ok, why?, app?, at}`,
  made from `desktop.acted`, `chrome.acted` and `hands.acted`. It is what "the agent is doing
  this now" shows in Glass, the Deck, the Capsule, chat and the phone, and what a chat tool row
  links to by `call`.

Rules. Screen text, selection, field values and URLs' query parts never go into an event or a
table. `mac` reads refuse any caller that came over the tailnet (the `screen` module already
does). A blind place (the floor) stays blind in every part. Steps keep only the action, a summary
the acting module wrote, the app and the outcome.

### 2. context: where the user is now

- `context.report {surface, device?, project?, cwd?, thread?, app?, window?, url?}` is how a
  surface says what it sees: the Capsule on app switch, chat on thread open, the phone on
  foreground. Fields not given are left as they were for that surface. `url` is kept without its
  query and fragment. Text and selection are refused.
- `context.now {parts?}` returns `{project, cwd, thread, surface, device, app, window, url, at,
  surfaces: [{surface, device, at}]}`: the latest value of each field across surfaces, with
  `project` found through `projects.of {cwd}` when only a folder is known. `parts: ["screen"]`
  adds `sight.now {target: "mac", parts: ["text"]}` on a Mac.
- Event `context.changed {changed: [field names], project?, thread?, surface, device?}`, at most
  one per second per surface. It carries no app, window or url.

Held in memory only. A restart forgets it, which is right: the next report rebuilds it.

### 3. suggest: one predictive-text tool

- `suggest.query {text, cursor?, surface, context?, limit?}` returns `{items: [{kind, sub?, label,
  insert, detail?, action?, source, id, score}], ms, late?: [source]}`. `id` is what
  `suggest.picked` takes; `sub` (agent, project, thread, person) picks an icon. Kinds: `mention` (agent,
  project, thread, person), `command`, `account`, `entity`, `phrase`, `file`, `time`. The token at
  the cursor decides the lane: `@x` mentions, `/x` commands, anything else entities and phrases.
- Built-in sources are lists the module caches and refreshes on their events, so a keystroke calls
  no tool: agents, projects, threads, connections (`vault.connections.list`), upcoming planner
  items.
- A module adds a source with `suggest.offer {tool, kinds}` at every start, as senders do with
  `gate.offer`. The tool gets `{prefix, text, surface, context, limit}` and has 25 ms; a late
  answer is dropped from that keystroke and named in `late`.
- `suggest.picked {kind, source, id}` raises that item for next time.
- IQ answers are not suggestions. A surface calls `iq.ask` once the user pauses, never per key.

### 4. waiting: one "waiting on you"

- `waiting.list {limit?}` merges `threads.asks`, `gate.held`, `planner.ringing` and
  `link.pending` into rows `{id, kind: "ask"|"draft"|"reminder"|"pairing", title, detail?,
  project?, thread?, at, source, answer: {tool, input, fill}}`, newest first, with `count`,
  `by_kind` and `partial` (sources that could not be read). `fill` names what the person still
  gives (a decision, a pairing code).
- `waiting.count {}` returns `{count, by_kind}` only.
- Event `waiting.changed {count, by_kind}`, when the count moves, after the owners' own events.

Answering stays with the owner (`threads.answer`, `gate.approve`, `planner.done`,
`link.pair.approve`); `answer` says which. Push, the Capsule, the Deck, the phone and the status
line all render from `waiting.list`, so one answer clears every device.

### Adopted, not built

- Connections for a capability: `vault.connections.list {capability?, surface?}` (ADR 0028 9b).
- Credentials: `vault.need` and `vault.connect` (ADR 0028 9a). Every module that lacks one
  answers with one error shape, `{code: "needs_credential", detail: {module, need, account?}}`,
  and every surface turns that into the vault's sheet.
- Commands: `does.commands` (ADR 0033), rendered by every surface.
- Settings and tokens: the hub (ADR 0035).

## Consequences

- A new surface gets screen, context, suggestions and needs from four calls.
- Owners need small changes, each through its own contract: acting modules put `thread` and
  `call` on their acted events; the Capsule and chat call `context.report`; push reads
  `waiting.list`. Each is listed in docs/work/cohesion.md with its owner.
- Four more modules start on each machine. Each is idle until called or until an event it follows
  arrives, and none polls.
