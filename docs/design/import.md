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
2. **Choose.** The person ticks folders or projects and sees exactly what will go to their box:
   "412 sessions, 38 MB of text, from these 9 folders". They confirm once, and choose between
   "Import these now" (one time) and "Keep them in sync" (new sessions go too). Neither is chosen
   for them. On a device with no box, nothing moves: the device indexes what was chosen itself.
3. **Import, in stages, each usable when it lands.**

| Stage | What happens | Where | Cost | Usable when |
|---|---|---|---|---|
| a. Upload | Session files go to the box over federation's transport, scrubbed of secrets at ingest | device to box | none | per session |
| b. Search | Recall indexes the session's turns (keywords) | box | CPU, seconds | that session is indexed |
| c. Meaning | Embeddings for each turn (local model) | box | CPU, paced | its turns are embedded |
| d. Graph | People, orgs, projects and relations by rules | box | CPU | the next curator pass |
| e. Personal facts | The model reader reads the person's own turns | box | the Claude login, paced by the daily cap | read, in the background |

   Stages b to d need no model and no money. A session is searchable, and Vyre IQ can answer from
   it, as soon as stage b has it. Stage e runs on the person's Claude subscription at the reader's
   pace (config.memory.model: a one-time backfill pool, then a daily cap) and resumes after a
   restart, so it may take days for a long history. Nothing waits for the whole import.

## Contracts

### On the device (module `import`, device role; owner: memory-iq, with federation)

- `import.scan { folders? }` -> `{ sources: [{ id, path, kind: "claude"|"archive"|"folder",
  sessions, bytes, from, to, projects: [{ slug?, name?, cwd, sessions }], suggested: boolean,
  why? }] }`. Reads file names, sizes, times and the first line of each session (its folder)
  only. Never reads turns. Person callers only.
- `import.plan { include: string[], exclude?: string[] }` -> `{ plan, sessions, bytes, folders,
  box }`: exactly what would go, for the confirm screen.
- `import.start { plan, mode: "once"|"sync" }`: person-only with a person session (ADR 0032),
  never an agent. It records the consent (`sync.sessions.<machine>.on` for "sync", a one-time
  grant for "once") in the settings hub and hands the plan to federation's sender.
- `import.stop {}`: stops sending at once. Undoing an import is revoking the device
  (ADR 0008, amendment item 5), which deletes what it sent and everything derived from it.

### On the box (owner: memory-iq)

- Ingest: federation lands files in `<home>/synced/<machine>/`. Recall reads that root like any
  transcript folder, with `source: "mac-sync"` and the machine on every session row, and passes
  the machine into every derived row (turns, vectors, graph evidence, personal claims, IQ caches)
  so the delete is complete (e2e's condition).
- `import.status { machine? }` -> per stage `{ done, total, eta_s }`, plus `searchable_sessions`,
  `people`, `projects`, `facts` so far. For a surface that opens mid-import.
- Event `import.progress { machine, stage, done, total, eta_s }`, at most once every 2 seconds
  per machine, from Recall's `session.indexed`, the embedder's batches, `memory.curated` and the
  reader's passes. It carries counts only, never names or text.
- Event memory.graph-grew (proposed) `{ nodes, edges, new: [{ id, kind }] }` after each curator pass during an
  import, so a live graph view can add the new nodes without redrawing (ids and kinds only; the
  view reads labels through `memory.graph`, under its usual scope rules).

### Pacing and resumption

- Stages b to d use Recall's pacer (half duty, yields to the person's own work). Stage e is the
  reader's queue: newest sessions first, so recent work is answerable first.
- Every stage is idempotent and keyed by session and content hash, so a restart, a lost
  connection or a second import of the same files repeats nothing and pays for nothing twice.

## Consent and security

The same rules as session sync (ADR 0008, amendment "session sync to the box"), which covers a
one-time import too: per device, off by default, turned on only by a person with a person
session, excluded folders never leave the device, the box names the machine from the verified
peer and keeps its own copy of the switch, the secret scrub runs at ingest, trust is the lower of
the folder rule and `mac-sync`, and revoking or unpairing deletes everything that device sent and
everything derived from it. Discovery reads metadata only and sends nothing. e2e reviews the scan,
the confirm screen's wording and the ingest.

## Graph opportunities

What the imported history makes possible, largest value for the size first.

| # | Opportunity | What the person gets | Size | When |
|---|---|---|---|---|
| 1 | Import progress as a live graph | People, orgs and projects appear as sessions are read (the proposed memory.graph-grew event) | S memory, M Deck | 0.1.1 |
| 2 | "Who is ..." and "everything about ..." | One card per person or org: role, where they work, projects, last talked about, sources | S | 0.1.1 |
| 3 | Contradictions to confirm | Two values for one thing (two home cities, two spouses): one "waiting on you" card to pick, using the suggestions IQ corrections built | S | 0.1.1 |
| 4 | What changed | Per project, what memory learned since a date, from the person's own words (memory.today, widened) | S | 0.1.1 |
| 5 | Project timelines | Decisions, deploys and fixes per project, in order, each with its session | M | 0.1.2 |
| 6 | Multi-hop IQ answers | "What did my contact at Northwind ask for in June": person to org to project to turns, measured on the eval worlds before it ships | M | 0.1.2 |
| 7 | Merge and split suggestions | "Dana Reyes" and "dana" are one; two "Sam"s are two: suggested, the person decides | M | 0.1.2 |
| 8 | The graph in suggest and connections | Names complete everywhere (built); people linked to their accounts and threads | S | 0.1.1 (suggest done) |

## Sizes and what fits in 0.1.1

| Piece | Owner | Size | 0.1.1 |
|---|---|---|---|
| import.scan, import.plan, import.start, import.stop on the device | memory-iq (+ federation for start) | M | yes |
| Upload channel, cursor, consent record, delete on revoke | federation | L | if federation lands it; else local-only import |
| Box ingest: synced root, machine on every derived row, import.status, import.progress, memory.graph-grew (proposed) | memory-iq | M | yes |
| Onboarding and install steps (discover, choose, watch it fill) | launch | M | yes |
| Import screen and graph view designs | app-design | M | yes |
| Live graph view | Deck | M | relaunch after 0.1.1 unless the Deck is free |
| Security review | e2e | S | yes |

Without federation's upload in 0.1.1, the same screens import on the device itself (a Mac
without a box, or the box's own sessions), and "Send to your box" arrives when the transport does.

## Decisions for the user

1. After the first import, should "Keep them in sync" be offered on the same screen, unticked (the
   proposal), or only later in Settings?
2. How fast should personal facts be read the first time? At the default pace a long history takes
   days of background reading on the subscription. A bigger one-time backfill pool finishes in
   hours, and counts against the plan's usage limits, not dollars.
3. Claude Code deletes session files after 30 days by default (`cleanupPeriodDays`). Should
   onboarding offer to keep them longer? That writes to the person's own Claude Code settings,
   so it would ask first.
