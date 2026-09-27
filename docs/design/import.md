---
title: "Import: discover your sessions and build the graph"
summary: How Vyre finds every Claude Code session on a device, lets the person choose what to import, and makes it searchable and answerable while the graph fills in live. Stages, contracts, consent, sizes and owners.
audience: builders, agents
owner: memory-iq
status: draft
---

# Import: discover your sessions and build the graph

The user wants Vyre, during onboarding, to find every Claude Code session on a device, show them,
import what they choose, and let them use each session as soon as it is processed. The graph fills
in while they watch. This is 0.1.1's flagship. memory-iq leads it and owns the pipeline, the
events and the graph.

## The flow

1. **Discover (on the device, nothing leaves it).** A device-side scan lists the sources, each
   with its session count, date range, size and the projects it belongs to:
   - `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), grouped by the folder each session ran in;
   - an archive folder, if the person keeps one (they name it; Vyre never guesses at their disk);
   - any folder the person adds.
   Folders that look like development of Vyre itself, test fixtures, `<home>/quick` and the
   Capsule's ask folder are listed but not ticked, with the reason shown.
2. **Choose.** The person ticks folders or projects and sees exactly what will go to their server:
   "412 sessions, 38 MB of text, from these 9 folders". On the same screen, neither preselected
   (the user's decisions, 28 Sep):
   - "Import now", and next to it "Keep them in sync" (new sessions go too), unticked;
   - how fast to understand them: "Fast: understood in a few hours (uses more of your Claude plan
     today)" or "Gentle: over a few days (barely touches your plan)", each with its estimate from
     `import.plan`'s `pace`, and the plain line that search works immediately either way;
   - where it is true (`claude_keeps_days` from the scan), "Claude Code keeps sessions for 30 days;
     import now so they're kept in Vyre". Vyre never changes Claude Code's settings.
   They confirm once. On a device with no server, nothing moves: the device indexes what was
   chosen itself.
3. **Import, in stages, each usable when it lands.**

| Stage | What happens | Where | Cost | Usable when |
|---|---|---|---|---|
| a. Upload | Session files go to the server over federation's transport, scrubbed of secrets at ingest | device to server | none | per session |
| b. Search | Recall indexes the session's turns (keywords) | server | CPU, seconds | that session is indexed |
| c. Meaning | Embeddings for each turn (local model) | server | CPU, paced | its turns are embedded |
| d. Graph | People, orgs, projects and relations by rules | server | CPU | the next curator pass |
| e. Personal facts | The model reader reads the person's own turns | server | the Claude login, paced by the daily cap | read, in the background |

   Stages b to d need no model and no money. A session is searchable, and Vyre IQ can answer from
   it, as soon as stage b has it. Stage e runs on the person's Claude subscription at the reader's
   pace (config.memory.model: a one-time backfill pool, then a daily cap) and resumes after a
   restart, so it may take days for a long history. Nothing waits for the whole import.

## Contracts

### On the device (module `import`, device role; owner: memory-iq, with federation)

- `import.scan { folders? }` -> `{ sources: [{ id, path, kind: "claude"|"archive"|"folder",
  sessions, bytes, from, to, folders: [{ cwd, sessions, bytes, from, to, project?, name?,
  suggested, why? }] }], left_out: { vyre, excluded }, capped, claude_keeps_days }`. Reads file
  names, sizes, times and the first lines of each session (its folder) only, within caps (20,000
  files, 64 MB of first lines). Never reads turns. Left out before anything is listed (e2e): work on
  Vyre itself, folders the person excluded, and credential folders (`~/.ssh` and the like), which
  are never walked. Person surfaces only; no model or agent can call it.
- `import.plan { include: string[], exclude?: string[] }` -> `{ plan, sessions, bytes, folders,
  pace: { turns, usd, fast: { hours }, gentle: { days } } }`: exactly what would go, and how long
  understanding it would take at each pace.
- `import.start { plan, mode: "once"|"sync", pace: "fast"|"gentle" }`: person-only with a person
  session (ADR 0032), never an agent. It records the consent in the settings hub
  (`sync.sessions.<machine>.on`) with the plan's hash, so a changed plan needs new consent, and
  hands the plan to federation's `sync.send` (module-only). "fast" sizes a one-time reading pool
  to the estimate; "gentle" keeps the daily cap.
- `import.stop {}` stops sending and deletes nothing. `import.cancel {}` stops and deletes the
  partial import the same way the person's delete does (e2e).
- What came from a device is the person's (ADR 0008, amendment item 5): unpairing, replacing or
  losing the device, or turning sync off, deletes nothing. "Delete everything that came from
  <device>" is the person's own action, with a preview (`memory.device { machine }`: sessions,
  turns, facts, people and orgs only it supports) and one confirm; federation deletes the files
  and emits `sync.deleted { machine }`, and memory and Recall forget everything derived.
### On the server (owner: memory-iq)

- Ingest: federation lands files in `<home>/synced/<machine>/`. Recall reads that root like any
  transcript folder, with `source: "mac-sync"` and the machine on every session row, and passes
  the machine into every derived row (turns, vectors, graph evidence, personal claims, IQ caches)
  so the delete is complete (e2e's condition).
- `import.status { machine? }` -> per stage `{ done, total, eta_s }`, plus `searchable_sessions`,
  `people`, `projects`, `facts` so far. For a surface that opens mid-import.
- Event `import.progress { machine, stage, done, total, eta_s }`, at most once every 2 seconds
  per machine, from Recall's `session.indexed`, the embedder's batches, `memory.curated` and the
  reader's passes. It carries counts only, never names or text.
- Event `memory.graph-grew { nodes, edges, new: { person, org, ... }, updated }` after a curator pass
  that added people, orgs or projects: counts by kind only (a node's id is its name). A live graph
  view then reads what is new with `memory.graph { since }`, under its usual scope rules.

### Pacing and resumption

- Stages b to d use Recall's pacer (half duty, yields to the person's own work). Stage e is the
  reader's queue: newest sessions first, so recent work is answerable first.
- Every stage is idempotent and keyed by session and content hash, so a restart, a lost
  connection or a second import of the same files repeats nothing and pays for nothing twice.

## Consent and security

e2e's conditions for the import (28 Sep), on top of ADR 0008's: caps on the scan and first lines
only; nothing but folders and counts in a plan; exclusions applied before listing; the server refuses
files unless its own record of the switch is on for that machine, and consent carries the plan's
hash; cancel deletes the partial import like the person's delete; the secret scrub runs at ingest, before
indexing, with the quarantined count shown to the person; the machine on every derived row,
IQ caches and fixes included; and no agent sees or starts a scan, a plan or progress.

The same rules as session sync (ADR 0008, amendment "session sync to the server"), which covers a
one-time import too: per device, off by default, turned on only by a person with a person
session, excluded folders never leave the device, the server names the machine from the verified
peer and keeps its own copy of the switch, the secret scrub runs at ingest, trust is the lower of
the folder rule and `mac-sync`, and a person-chosen delete removes everything that device sent and
everything derived from it; unpairing alone deletes nothing. Discovery reads metadata only and sends nothing. e2e reviews the scan,
the confirm screen's wording and the ingest.

## Graph opportunities

What the imported history makes possible, largest value for the size first.

| # | Opportunity | What the person gets | Size | When |
|---|---|---|---|---|
| 1 | Import progress as a live graph | People, orgs and projects appear as sessions are read (`memory.graph-grew`) | S memory, M Deck | memory side built |
| 2 | "Who is ..." and "everything about ..." | One card per person or org: role, where they work, projects, last talked about, sources | S | built: `memory.card` |
| 3 | Contradictions to confirm | Two values for one thing (two home cities, two spouses): one card to pick | S | built: `memory.contradictions`, `memory.settle` |
| 4 | What changed | Per project, what memory learned since a date, from the person's own words (memory.today, widened) | S | 0.1.1 |
| 5 | Project timelines | Decisions, deploys and fixes per project, in order, each with its session | M | 0.1.2 |
| 6 | Multi-hop IQ answers | "What did my contact at Northwind ask for in June": person to org to project to turns, measured on the eval worlds before it ships | M | 0.1.2 |
| 7 | Merge and split suggestions | "Dana Reyes" and "dana" are one; two "Sam"s are two: suggested, the person decides | M | 0.1.2 |
| 8 | The graph in suggest and connections | Names complete everywhere (built); people linked to their accounts and threads | S | 0.1.1 (suggest done) |

## Sizes and what fits in 0.1.1

| Piece | Owner | Size | 0.1.1 |
|---|---|---|---|
| import.scan, import.plan, import.start, import.stop on the device | memory-iq (+ federation for start) | M | yes |
| Upload channel, cursor, consent record, the person's delete | federation | L | if federation lands it; else local-only import |
| Server ingest: synced root, machine on every derived row, `import.status`, `import.progress`, `memory.graph-grew` | memory-iq | M | yes |
| Onboarding and install steps (discover, choose, watch it fill) | launch | M | yes |
| Import screen and graph view designs | app-design | M | yes |
| Live graph view | Deck | M | relaunch after 0.1.1 unless the Deck is free |
| Security review | e2e | S | yes |

Without federation's upload in 0.1.1, the same screens import on the device itself (a Mac
without a server, or the server's own sessions), and "Send to your server" arrives when the transport does.

## Decided (the user, 28 Sep)

1. "Keep them in sync" is offered on the first screen, unticked, next to "Import now".
2. The first read's pace is the person's choice on the import screen, neither preselected, with
   estimates: Fast (a few hours, more of the plan today) or Gentle (a few days).
3. Vyre never touches Claude Code's settings; where true, it says "Claude Code keeps sessions for
   30 days; import now so they're kept in Vyre".

## Decisions that were open

1. After the first import, should "Keep them in sync" be offered on the same screen, unticked (the
   proposal), or only later in Settings?
2. How fast should personal facts be read the first time? At the default pace a long history takes
   days of background reading on the subscription. A bigger one-time backfill pool finishes in
   hours, and counts against the plan's usage limits, not dollars.
3. Claude Code deletes session files after 30 days by default (`cleanupPeriodDays`). Should
   onboarding offer to keep them longer? That writes to the person's own Claude Code settings,
   so it would ask first.
