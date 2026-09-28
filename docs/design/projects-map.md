---
title: "How a project ties Vyre together"
summary: A project is a home folder plus everything picked into it. This maps how sessions, IQ, watchers, teammates, helpers, chat, the vault and files each touch a project, with an owner and a built/gap mark for each.
audience: builders
owner: sessions
status: draft
---

# How a project ties Vyre together

A project (`core/projects`, owner: projects) is a home folder declared by
`<home>/.vyre/project.json`, plus the threads, people and watchers picked into it. Nothing is
automatic: a person picks sessions from the catalogue by hand. Every other part below reads or
writes through the project, never around it.

## Sessions and threads (owner: sessions)

A thread belongs to a project either because it ran in one of the project's folders, or because
a person picked it (spec 7.2). `projects.context {project}` builds the **brief**: what the
project is, its people, its other threads by name, its folders, and memory facts, capped near
600 tokens, from that project only. A new Vyre-owned session appends the brief once at start
(`--append-system-prompt`, or the plugin's SessionStart hook when the harness plugin is present).
A session can be picked into several projects later (attach-later, cohesion item 19: person-only,
preview then one confirm, no Touch ID).

Built: `projects.context`, the brief, pick/unpick, folder membership. Gap: attach-later's exact
tool shape is still being settled between projects and memory-iq (below); `vyre resume` against
real Claude Code (only run against the fake so far).

## IQ and memory (owner: memory-iq)

Memory (branded **Vyre IQ**) rooms are per-project: a project's picked threads become members of
its room (`projects.list`'s `picks` field feeds this), and `memory.facts {project_cwds}` answers
only from that room, never another project's. **Project graphs** connect a project's people, facts
and threads for retrieval (`recall.search` with a `sessions` filter over the project's folders and
picks). **`memory.today`** is a running line ("Lately in this project") that `harness.brief` folds
into every new session's brief, so IQ's memory of the last few days rides in for free instead of
being asked for.

Built: `memory.facts`, project graphs, `memory.today` in the brief. Gap: attach-later's graph join
when a thread moves projects; host-to-server sync of a project's room (contract agreed with
federation, ADR 0008 amendment, federation itself paused).

## Watchers (owner: cohesion (glue), various (the underlying signal))

A watcher is a name on the project marker (`watchers`, spec 7.2), someone who should hear about
this project's `Needs` without running a session in it. Cohesion's `core/waiting` module is the
glue: it turns a project's asks, merge failures and stuck teammates into one `Needs you` feed a
watcher's own surfaces poll, keyed off `link.pending`'s `created` field rather than a TTL guess.

Built: `core/waiting` (6 tests, on main). Gap: watchers as a first-class field on the project
marker and a UI to add/remove one are not built; today only the owning person sees Needs rows.

## Teammates (owner: teammates (ADR 0031))

A project may have named teammates, at most one per role (`design`, `backend`, `research`, ...).
Each is a Vyre agent scoped to that project (`agent = <role>-<project>`), with its own worktree,
notes file under `<project home>/.vyre/team/<role>/notes.md`, and a serial inbox. Any session in
the project gets a `team.ask` tool and is told in its append: send this project's design work to
`design`, keep subagents for one-offs. A shared teammate keeps one inbox and notes file but a
separate per-project notes section and a separate sleeping session per project, so one client's
work never bleeds into another's.

Built: nothing yet, design only (ADR 0031 complete, app-design's boards approved). Blocked on
sessions' slot ledger and usage pause (section 14 of the ADR), which sessions builds next as part
of `core/team`'s first migration step. Gap: everything in the ADR's Migration section (9 steps).

## Helpers and subagents (owner: sessions)

Inside a project's concurrency, a **subagent slot** limits how many Task-tool subagents run at
once across every session in that project (teammates' helpers, a person's own Chat or terminal
subagents, jobs), bounded because Claude Code runs subagents inside the parent process, so slots
cap tokens, not processes. An **active-teammate slot** is separate and covers a teammate's own
running request. Presets (Light/Balanced/Max/Custom) are set per project, capped by a box-wide
ceiling, with a fair FIFO queue and an ETA, and pause automatically when the plan's usage window
gets close to its limit.

Built: `sessions.slots` (take/release/status), the per-auth usage pause, purposes `teammate`
(Opus) and `helper` (faster model). Gap: the settings screen for presets (native-core owns the
Settings surface; not yet wired to a live project); the Task-tool hold in `canUseTool` waiting on
a free slot is built for owned sessions but not yet exercised end-to-end with a real teammate,
since teammates itself hasn't started building.

## Chat (owner: chat / pwa (surface), sessions (data))

The Deck's project picker lists projects from `projects.list`; a new session started from inside a
project's context (`context.now`, cohesion's glue module) starts *in* that project, its cwd, its
brief, its teammates if any, rather than needing the person to say which project they mean.
`context.now` is also what a teammate's summon box and the Capsule's `@role` read to guess the
right project from where the person already is.

Built: `projects.list`/`projects.context` (sessions/projects side); `core/context` (cohesion, 9
tests). Gap: the Deck's actual project-picker UI and "new session starts in this project" wiring
are chat/pwa work, paused during the native-core refocus; not confirmed shipped.

## The vault (owner: vault)

Grants are per agent today (`vault_agent_grants`), not yet per project. ADR 0031 asks for a
`project` column so a shared teammate's grant only releases for requests from the project it names,
and vault-next's own notes list "agent grants per project: project column, check on every use,
revoke by project" as a queued Next item. Credentials injected as env vars at a session's start
(the pattern this map was asked to point to) has **no design doc yet**, `docs/design/
session-credentials.md` does not exist in either the vault or the sessions worktree as of this
writing. What does exist: sessions' own Next list carries "threads record origin (the Capsule) for
vault's surface mapping" and "Claude sign-in as a vault need (`needs.credentials` on threads,
`onboard.claude` callable by `module:vault`)", the shape, not the doc.

Built: agent-level grants, `vault.uses` logging, revoke on agent removal. Gap: the `project` column
on grants (vault-next, queued); the session-credentials design doc; per-project env injection at
session start.

## Files and Vyre Drive (owner: projects + files (cohesion item 19))

A project's files live under its home and workspaces today, addressed by folder membership alone.
Item 19 (cohesion's cross-team spec, direction-and-owners only, not built) adds a **files router**
so a file can be attached to a project without living in its folder tree, an
**attach-a-session-to-a-project-later** flow shaped like `projects.move` (person-only: preview,
one confirm, no Touch ID; an agent may suggest, never call it), and **Vyre Drive** as the branded
front end (built on Tailscale's Taildrive) with a moved-file event federation credits so the right
device sees the change.

Built: the folder-membership case (already part of `core/projects`). Gap: the router itself, the
attach flow's exact tool, the graph join when a thread's project changes (memory-iq to settle),
and Vyre Drive's UI, all queued for 0.1.1, no owner has started code.

---

## A day in Harlow Legal

Harlow Legal is the sample-world firm (home `~/Work/harlow-site`) used across the design docs.

1. **Morning.** Dana opens the Deck. The project picker (chat/pwa) shows Harlow Legal alongside
   Northwind Bakery. She picks Harlow; `context.now` records it.
2. **A new session starts in context.** She starts a session without naming a project, it lands
   in Harlow automatically (context.now), gets the brief (`projects.context`: Harlow's people,
   its other threads, memory facts from Harlow's room only) and `memory.today`'s "Lately in this
   project" line.
3. **She asks for design work.** The session's append already says "this project has teammates:
   design, backend, send their work to them." She types `@design make the intake form calmer`.
   That becomes a `team.ask` request, queued in design's one inbox (teammates, once built),
   holding an active-teammate slot (sessions) for as long as it runs.
4. **Design finishes.** Its result posts back to Dana's thread as a `teammate-result` inbox item,
   labelled as design's report, not her own words. It touched `intake/estate.tsx` on branch
   `team/design`.
5. **The integrator merges.** A merge request queues to Harlow's integrator teammate, which
   merges `team/design`, runs the project's test command, and fast-forwards main, or raises a
   "Merge failed" Needs-you row naming the failing test.
6. **IQ remembers.** The whole exchange becomes part of Harlow's project graph; a fact learned
   about Harlow ("the client signs with a middle initial") goes through `learn.add` into memory,
   never into design's notes file, which stays about how the role works.
7. **A watcher hears about it.** Alex, who watches Harlow but runs no sessions there, sees the
   merge and any stuck items in his own Needs feed (cohesion's `core/waiting`) without opening a
   Harlow session at all, once watchers are wired to the project marker (gap, above).
8. **A file gets attached.** Dana drags a signed retainer PDF into the project from outside its
   folder tree; item 19's attach flow (once built) previews where it lands, she confirms once, and
   Vyre Drive shows it credited to her device.
9. **Grants stay scoped.** Design's teammate never sees Northwind's vault credentials: today
   because grants are per-agent and design's agent only serves Harlow; once vault-next's `project`
   column lands, the same holds for a teammate shared across both firms.

## Open findings (cohesion's one-product audit, 2026-09-28)

- **Project identity has four unrelated shapes**: the marker plus slug (projects), memory's
  folder-path list (memory-iq), a teammate's agent-name suffix `<role>-<project>` (teammates), and
  soon a vault grants column (vault), nothing declares them the same thing. Fix: one canonical
  project-id type in `core/projects`; the others become derived views, not separate truths.
- **Watchers have no on-ramp beyond the session owner**: the marker field and add/remove call
  named as a gap above don't exist yet, so a person who isn't the session owner has no way to
  watch a project at all today.
- **No session-credentials doc exists** (env injection at a session's start), vault is now
  writing `docs/design/session-credentials.md` per the lead; coordinate the shape with them
  directly rather than duplicating it here.

`core/projects` has no active teammate right now (its own work doc shows "Doing: Nothing," and no
`projects` agent is in the current roster), these three need an owner assigned before they can be
built, flagged to the lead.

## Owner and status summary

| Part | Owner | Status |
|---|---|---|
| Projects core (marker, catalogue, brief, CLI) | projects | Built |
| Sessions/threads belonging to a project, attach-later | sessions / projects | Built (attach-later gap) |
| Memory rooms, project graphs, memory.today | memory-iq | Built |
| Watchers | cohesion (glue) / projects | Gap, no marker field or UI yet |
| Teammates (ADR 0031) | teammates | Design only, blocked on sessions' slots |
| Helpers/subagent + teammate slots, usage pause | sessions | Built; settings UI gap |
| Chat project picker, context.now-started sessions | chat / pwa | Data built; UI paused |
| Vault grants per project, session credential injection | vault | Gap, no `project` column, no design doc |
| Files router, attach flow, Vyre Drive | projects + files (cohesion item 19) | Gap, spec only, 0.1.1 |
