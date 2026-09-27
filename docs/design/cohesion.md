---
title: "Cohesion: making Vyre one system"
summary: The ranked map of places where Vyre's modules and surfaces should share one answer, who owns each, and the shared contracts behind them (ADR 0036).
audience: builders, agents
owner: cohesion
status: draft
---

# Cohesion: making Vyre one system

Status: approved as ranked by the lead, 27 Sep 2026. Contracts: ADR 0036. Tracker:
docs/work/cohesion.md. Nothing here moves a feature out of its team. Cohesion writes the shared
contracts, four small glue modules behind them (sight, context, suggest, waiting), and the tests
that keep surfaces from drifting apart again.

## The problem in one paragraph

Each module is good on its own, and each surface rebuilds the parts it needs. The Capsule has its
own intent rules, model names, command table and memory answer. The Deck keeps a stale copy of the
passkey tool list. Five account lists have five shapes. Nobody knows what is on screen or which
project the user is in, so every surface guesses. What an agent does on its computer reaches no
view at all: the acted events have no listener, and Glass shows only take-overs. There is no
suggest tool, no notice contract and no single "waiting on you" count.

## Principles

1. One owner per fact. A surface never keeps a copy of a list another module owns (models,
   commands, accounts, tool policies, tokens). It reads the registry and follows the change event.
2. Glue owns no data. A glue module fans out to other modules' tools under a deadline and merges
   the answers. Switch it off and each owner still works on its own.
3. Every change has an event, and the event carries enough to act on.
4. The same input gets the same answer on every surface. Routing, ranking and wording live on the
   box.
5. One service, both sides. Where the user and an agent do the same kind of thing (look at a
   screen, act in an app, fill a password, get reminded), one contract serves both, keyed by who.

## Ranked opportunities

Ranked by how much each makes Vyre feel like one system in daily use. Effort: S (a day), M (a few
days across two or three teams), L (a week or more, several teams).

| # | Opportunity | Owners | Effort | State |
|---|---|---|---|---|
| 1 | One screen service on both sides: the Capsule sees the Mac, everyone sees what an agent does | cohesion (sight), capsule-pro, pwa, mobile, sessions, chat | M | glue built |
| 2 | Context now: project, thread, surface, device | cohesion (context), capsule-pro, chat, pwa, mobile, sessions | M | glue built |
| 3 | Connections for a capability ("send an email" offers every account) | vault, connectors, capsule-pro, pwa | M | vault owns |
| 4 | Suggest: one predictive-text tool for Capsule, chat and phone | cohesion (suggest), memory-iq, capsule-pro, chat, native-core | L | glue built |
| 5 | One ask path, with the wife's-name fix | memory-iq, sessions, capsule-pro, chat | M | owners |
| 6 | Vyre commands everywhere, rendered in the Capsule | platform, polish-cli, capsule-pro, chat | M | owners |
| 7 | Every key set up once, through the vault | vault, connectors, polish-cli, capsule-pro, pwa | M | vault owns |
| 8 | One "waiting on you" and one notice path | cohesion (waiting), pwa, capsule-pro, mobile, polish-cli | M | glue built |
| 9 | The hub read live by every surface | native-core, platform, app-design, capsule-pro, mobile, sessions | M | owners |
| 10 | One live catalog of projects, threads and agents | sessions, capsule-pro, chat, mobile | S | owners |
| 11 | Tips everywhere, in one slot, relevant to now | docs (tips), app-design, every surface | M | contract |
| 12 | Memory learns from the whole system | memory-iq, connectors, sessions | M | owners |
| 13 | One devices list and one pairing story | relay, vault, pwa, e2e | L | proposed |
| 14 | Sessions start knowing today (agenda, accounts, what is waiting) | sessions, memory-iq | S | proposed |
| 15 | One card set for asks, approvals and plans | app-design, chat, pwa, mobile, capsule-pro | M | proposed |
| 16 | Event vocabulary and a live event catalog | platform, cohesion | S | proposed |
| 17 | Shrink the boundaries allowlist | ci, owners of each edge | M | proposed |

### 1. One screen service on both sides

**The user's words:** show what is happening on the agent's computer right now and what the agent
is doing, and let the Capsule see the screen: the same service, working on two sides.

**Today.** The Mac side is `screen.context` (front app, window, focused control, URL, visible text,
redacted and blind in the floor's places), local only. The agent side is a VNC stream
(`computers.watch`), a control tree (`hands-desktop.tree`, `chrome.snapshot`) and acted events
(`desktop.acted`, `chrome.acted`, `hands.acted`) that nothing listens to. No link from a chat tool
row to what happened on screen.

**Contract (built, core/sight).** A target is `mac` or `agent:<name>`.
- `sight.targets` lists both kinds.
- `sight.now {target, parts?}` gives app, window, URL (no query), the last step and who holds the
  keyboard. The Mac adds text only when asked and only on the Mac; an agent adds its controls.
- `sight.watch {target}` gives an agent's live frames; the Mac answers `local_only`.
- `sight.steps` and the event `sight.stepped {target, agent, thread, call, action, summary, ok}`
  are "what the agent is doing now": the Glass mini-view with its current step, in the Deck, the
  Capsule, chat and the phone.

**Owners' parts.**
- capsule-pro: the Capsule's screen context and "about this page" read `sight.now {target:"mac"}`;
  a "Kit is working" pill shows the latest `sight.stepped` for a running agent.
- pwa and mobile: a Glass mini-view (the frame from `sight.watch` and the step line) on Now and in
  a thread.
- sessions and chat: tool rows carry the tool call id; acted events carry `thread` and `call`, so a
  row opens the frame at that step.
- Acting modules (hands-desktop, hands-chrome, hands-mac): add `thread`, `call` and `app` to their
  acted events, and cut query strings from summaries. `chrome.open` puts the full URL with its
  query in its summary today.
- Registry (platform): carry the tool call id in call meta, so modules can put it on events.

### 2. Context now

**Contract (built, core/context).** `context.report` is how a surface says where the user is (the
Capsule on app switch, chat on thread open, the phone on foreground, the CLI with its folder).
`context.now` merges the latest of each field across surfaces and finds the project from the
folder. `context.changed` names what changed, at most once a second, and never carries the app,
window or URL. Text and selection are refused. A model cannot report or read it.

**Consumers.** The Capsule (default project, ask folder, screen), chat (a new thread lands in the
right project), harness and Vyre IQ (scope and boost), push (ring the device in use), tips (item
11), suggest (ranking).

### 3. Connections for a capability

The vault owns it (ADR 0028 decision 9b): one connections table fed by google, mcp and vault
events, capability names, per-surface grants, and a `use` call per row. Cohesion does not build a
second one. What cohesion checks: the Capsule's "send an email" rows, `gate.route`'s options,
Slack's server choice and the Deck's Connections view all read that one list; suggest's account
lane reads it too. Open with the lead: vault's and connectors' ADRs both plan a mail module.

### 4. Suggest

**Contract (built, core/suggest).** `suggest.query {text, cursor, surface}` answers in about 2 ms
from cached lists (agents, projects, threads, people, upcoming planner items, connections), and
asks offered sources with a 25 ms deadline. `@x` is mentions, `/x` commands, anything else
entities, accounts and times on the last word. `suggest.offer` is how a module adds a source at
start; `suggest.picked` teaches ranking.

**Owners' parts.** memory-iq offers personal entities and aliases ("my wife", graph labels) from
memory already loaded, never a model call; the Capsule and the chat composer (chat-core, so the
Deck, PWA and Expo all get it) call it per keystroke. Vyre IQ answers come on pause, not per key.

### 5. One ask path

The box decides question versus task and the model for every surface, and the memory answer comes
from memory, then Vyre IQ. The Capsule retires Said.swift, its own question rules and its
hardcoded model names. Rides with the wife's-name fix: memory-iq and sessions own it, and
memory-iq's source-trust rules apply.

### 6. Commands everywhere

Platform's manifest field for commands (ADR 0033) is the one source for the CLI, the Capsule's
commands, chat's slash menu and the Deck. A result shape (table, text or card) lets the Capsule
and chat draw Vyre output instead of printing terminal text. polish-cli adds JSON output to the
seven commands without it (capsule, connect, hooks, mcp, sideview, voice, send).

### 7. Every key set up once

The vault owns it (ADR 0028 decision 9a: a need per module, one connect step that stores and
grants). Six flows retire into it: the voice key command, the grant command for the Claude token,
onboarding's Claude step, connectors' client item, the push and tailnet keys. Cohesion's part is
one error shape every module answers with when a credential is missing, `needs_credential` with
the module and the need, so every surface opens the same sheet. The names module still reads its
token from the environment before the vault.

### 8. One "waiting on you"

**Contract (built, core/waiting).** `waiting.list` merges open questions, held drafts, ringing
reminders and pending pairings into one row shape and one count; each row says which owner tool
answers it and what the person still gives. `waiting.changed` fires when the count moves.

**Owners' parts.** Push, the Capsule's "Waiting on you" row, the Deck, the phone and the status
line all render from it, so one answer clears every device and a phone stops ringing twice.
Modules declare their notice kinds in their manifest instead of push keeping a fixed map.

### 9. The hub read live everywhere

In flight with native-core (ADR 0035) and platform. Cohesion's part: the change event carries the
value, and a drift test fails any surface that ships its own model list, effort list, tool-policy
list (the Deck's and the app's copies of the passkey list are already out of step with the box) or
a token file not generated from the hub.

### 10. One live catalog

Projects, threads (with status) and agents in one call, with one documented refresh event set.
Fixes the Capsule's per-project loop and its second copy in sight's extension.

### 11. Tips everywhere

**The user's ask:** unobtrusive tips about the module in use and about modules not tried yet, and
"what's new" after an update.

**Split.** The docs team owns the words and a small tips module (next tip for a surface and a
context); tips live in each module's manifest next to what it teaches memory. Cohesion owns the
slot and the signals:
- One tip slot per surface, specified once by app-design: the Capsule's empty state, chat's
  composer hint line, the Deck's empty states, the phone's empty screens, the CLI's "next" line
  and the status line. One tip at a time, dismissable, never over a question or an approval.
- Relevance comes from the shared signals: `context.now` (which project, which app is in front),
  `sight.now` (what is on screen, on the Mac only), `waiting.count` (never tip while something
  waits), suggest's picks (what the user already uses) and the registry's module list (what is
  installed and never used).
- "Module never used" needs a per-module use count. Today nothing records it; the event log's
  source column is a rough stand-in. Ask platform for a count in the registry.
- "What's new" needs the last version each surface saw, and entries from the changelog or a
  per-module note.

### 12. Memory learns from the whole system

Memory listens only to thread and session events. Add planner (people and places), approved
sends (who the user writes to), the user's own accounts, and calendar attendees: first-party
records only, never tool or test text.

### 13 to 17, in short

- **Devices:** six lists (vault devices, relay devices, person sessions, push devices, onboarding
  peers, link peers). One device row with its capabilities, one list in Settings, one pairing
  story.
- **Sessions start knowing today:** the session brief adds the agenda, the waiting count and the
  project's connections, inside its 600-token budget.
- **One card set:** ask, approval and plan cards from the design system, built once in chat-core
  for web and Expo, mirrored in Swift from the same spec.
- **Events:** a catalog tool from the manifests; one noun form (file versus files, computer versus
  computers) with aliases for a release; names built at run time documented.
- **Boundaries:** 26 frozen edges; most are shared-library moves (tailscale, transport, auth).

## One service, both sides

Every pair where the user and an agent do the same kind of thing through two services today.

| Pair | The user's side | The agent's side | One contract |
|---|---|---|---|
| Seeing a screen | `screen.context` on the Mac | tree, snapshot and frames in Glass | `sight.*` (built) |
| Acting in an app | hands on the Mac (holds sends for commit) | hands-desktop and chrome (refuse sends) | one hands vocabulary and one send rule, both held for the person |
| Showing what happened | nothing on the Mac | acted events, unread | `sight.stepped` for both |
| Watching a screen | side view on the Mac | Glass on the box | side view opens a Glass target; one viewer |
| Files | files on the Mac and the box | Glass files in the agent's home | one files contract keyed by where, so the phone reaches the Mac too |
| Filling a password | autofill on the user's devices | fill into an agent's computer | one vault fill with a grant log for both |
| Reminders | planner for the person | watchers and scheduled work for agents | one "due" row in waiting for both |
| Being asked | the gate for the person's sends | an agent's question in a thread | one waiting list (built) |
| Memory | the person's facts | project and agent rooms | one answer path with scope, not two stores |
| Terminal | `term` on the Mac | `term` on the box | already one module |

## Cross-cutting contracts

| Contract | Tools | Event | Module |
|---|---|---|---|
| Screen, both sides | `sight.targets`, `sight.now`, `sight.watch`, `sight.steps` | `sight.stepped` | core/sight |
| Context now | `context.report`, `context.now` | `context.changed` | core/context |
| Suggest | `suggest.query`, `suggest.offer`, `suggest.picked` | none | core/suggest |
| Waiting on you | `waiting.list`, `waiting.count` | `waiting.changed` | core/waiting |
| Connections | the vault's connections list | vault's | vault (ADR 0028) |
| Credentials | the vault's need and connect | one `needs_credential` error shape | vault (ADR 0028) |
| Commands | platform's commands field | the module list | platform (ADR 0033) |
| Tips | docs' tips module | none | docs |
