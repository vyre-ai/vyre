# memory

Branch: work/memory · Worktree: ../vyre-memory · Milestone: M1

## Scope

Owns `core/memory/`, `core/cli/commands/memory.js`.

The graph and the curator. The curator is the ONLY writer to `memory_*` tables. It reads
Recall's tables directly (`recall_sessions`, `recall_turns`; see `core/recall/schema.js`) and
never runs a model. It extracts people, email addresses, domains, repos, projects and named
things; keeps bi-temporal edges (valid_from / valid_to) with provenance; every fact points at
the `(session, seq)` it came from. It learns short forms ("Harlow" for "Harlow Legal") and
the user's own identity from `config.me` (domains, emails), never from hard-coded lists.
Nothing about any real person or business may be in the code; the lexicon of stop words and
tool names (GitHub, Slack...) is generic and fine.

Runs incrementally: on `session.indexed` events (from Recall; tests can emit them by hand or
just call `memory.curate`), and on start for anything not yet curated. Idempotent: running
twice changes nothing (the prototype had a NULL-in-UNIQUE bug here; see its tests).

Treat a missing `(session, seq)` as gone. Recall re-indexes rewritten transcripts.

## Tools (module `memory`)

- `memory.facts {about?, project_cwds?, limit?}` → facts with source, age and confidence
- `memory.relevant {text, project_cwds?, limit?}` → the few facts worth adding to a prompt about
  this text, or `[]`. This is what the Harness's Enrich hook will call in M2: precision over
  recall, empty when nothing is relevant, fast (under 50 ms on the real corpus).
- `memory.why {fact}` → the turns that support it
- `memory.pin {node, scope?}` / `memory.mute {node, scope?}` → user steering
- `memory.curate {}` → run now: counts
- `memory.stats {}`

## Events

Emits `memory.curated {nodes, edges, ms}`. Listens to `session.indexed`.

## CLI

`vyre memory [about]` (facts, in the Recall gold colour from `core/cli/style.js`), `vyre why <fact>`.

## Port from

`the prototype's bin/curator.cjs`, `graph.cjs`, `lexicon.cjs`, `entities.cjs` (as a pattern only; its
data is personal); tests `the prototype's bin/test/t-curator.cjs`.

## Done when

- Against `seedRecall()`: Dana Reyes links to Harlow Legal and harlowlegal.com; Sam Okafor to
  Northwind Bakery; "Harlow" learned as a short form; Alex's own studio is not treated as a client
  when `config.me.domains` names it; every fact has a working `memory.why`.
- Idempotency and bi-temporal tests pass. A read-only smoke run on a real corpus, if a Recall
  index is available, reports counts and timings only.

## Done
- Rooms (ADR 0007 decision 1): per-room derive with the anchor rule, `'*'` main rows, per-room
  nodes and short forms, claimants resolved at read time, the new hub rule, `works_at` conflict
  marking, the unfiled room and the Enrich fallback to it. Tested: a room's rows are unchanged
  when every other room's sessions are deleted; room confidence ignores other rooms; a hub thread
  picked into two projects carries no client across; unfiled never sees project-private facts; a
  main client is not a hub.
- Decay at read time (decision 3): `seen` over all evidence, freshness per relation, Enrich
  scores times `fresh` with the 0.35 cut unless pinned, `stale`/`fresh`/`seen_age` on facts.
  Derive stays clock-free (tested with two curator clocks 400 days apart).
- Correct, merge, split (decision 4): `memory.correct` (wrong, ended, replace, confirm, add),
  `memory.corrections`, `memory.uncorrect`, `memory.merge`, `memory.split` (by room, or apart),
  owner callers only, applied in derive after the votes, conflicts recorded, events with the ADR
  payload, CLI subcommands and `--project`. `module.json` does/watches/shows as in decision 12.
- Resolution and new relations (decision 2): local parts across sessions, word-like TLDs and org
  words in domains, one identity per address, middle initials; `has_title`, `client_of`,
  `repo_for`, `deadline`; `prefers`/`decided` behind `config.memory.relations`, off. On the eval
  world every supported relation measures precision 1 and recall 1 except `deadline` (recall 0.5,
  see Next), Enrich P@3 0.949, empty on irrelevant 1.
- `memory.graph` (floor plan, rooms, `updated` cursor), strict project graphs, agent access checks.
- Taught facts scoped to a project with `fact.project_cwds`.
- Short forms pooled per identity (spellings sharing a domain), so "the Harlow team" style references match on the real index.
- `memory.teach` and lesson provenance; paged cold derive (worst event-loop block 70 to 120ms).
- Curator, graph, module, CLI (`core/memory/`, `core/cli/commands/memory.js`), on `work/memory`.
- Every "Done when" item above holds against `seedRecall()`, including a working `memory.why`
  for every fact. Idempotency, bi-temporal and rewrite tests pass.
- Smoke run on a temp copy of a real 103k-turn index (counts and timings only): 1,581 nodes,
  6,591 edges, 842 open facts. First pass 6.7s; nothing new 5ms; one new turn 1.2s with the
  event loop never blocked more than about 180ms; `memory.relevant` p50 0.06ms, p95 1.4ms.

- Eval: the Harlow deadline is gold-closed and a closed fact offered by `memory.relevant` fails
  (`closed.offered`); prefers/decided measured in a second run as optional relations; the
  `relevant` timing warms up and takes the best p95 of three rounds. Every ADR target is met, no
  todos left: leakage 0, all precision and recall 1, Enrich P@3 0.986.
- One identity per domain: org spellings sharing a domain are one node (longest proper label),
  other spellings in `memory_aliases`, matched by Enrich and resolve.
- Review fixes (`core/memory/scope.test.js`): corrections for everywhere stay out of rooms that
  do not know their subject, and their notes stay in their scope; nested project folders go to
  the most specific project, and agents are checked by project slug; the main graph needs an
  owner surface or an all-projects agent; owner tools refuse any caller naming an agent; exact
  objects for `memory.correct`; confirmed facts never closed by conflicts; lessons indexed per
  derive; `memory.correct` does not wait for the derive unless `wait: true`; the Deck sends
  `room`. Eval with the gold corrections: leakage 0, every precision and recall 1, Enrich P@3
  0.986.
- Picked threads are room members live: `projects.list` carries `picks` and room sync reads
  it; the eval world uses the real list shape and checks each pick is in its room (leakage 0).
- `memory.facts {thread, room?}` with `refs: [{seq}]` for gate-chat's Chat view; presence
  summaries on `correct`, `merge`, `split`; refusals coded `denied`; `tailnet:<login>` reads as
  the owner (`core/memory/access.test.js`).

## Doing

## Next
- prefers/decided: the eval's optional run (flag on) measures precision 1 and recall 1 for both,
  over the bar of 0.8, but on one gold fact each. Switching the default on is a decision for
  Intelligence; more gold (distractors that say "prefer" or "decided" in code talk) first.
- A split write means readers can see one room's new rows beside another's old ones for a
  moment; each room is consistent on its own. Revisit if the Deck shows it.
- Short forms for people's first names are measured but few pass the 0.6 floor; that is by
  design. Revisit if the Enrich hook misses obvious first-name references.

## Needs from others
- deck: `deck/views/projects.js` asks `memory.facts` with the project's folders; `room: slug`
  would read the right room for nested or folderless projects.
- main / harness / switchboard: put the agent in the caller for agent sessions, e.g. the MCP
  server and hooks sending `x-vyre-caller` with `agent:<VYRE_AGENT>` in it, and the daemon
  keeping a caller from claiming an agent it is not. Today an agent that does not name itself
  is treated as the user; Memory reads `agent:<name>` from the caller as soon as it is there.
  Mind that `callerKind` treats the whole string as the kind, so pick a format the vault's
  `mcp` checks still recognise.
- switchboard: `agents.list` returning `[{ name, kind, projects: "*" | [slug or name] }]`, as
  in SPEC section 10. Memory refuses any named agent until it exists.
- recall: emit `session.indexed {session, from, to, rewritten}` after each index write. Memory
  also copes without it (it compares `recall_sessions.turns` with what it has read on every pass,
  and treats a shrunk session as rewritten), but the event is what makes it prompt.
- recall: keep turn text in `recall_turns` as the contract says; Memory reads it by rowid and
  measures short forms with rowid-only `MATCH` queries.

## Changed contracts
- `memory.facts {thread, room?, limit?}` returns `{ thread, room: slug|"*", facts }`: facts whose
  evidence includes a turn of that thread (session id, exact: a subagent's turns are its own
  session), ordered by their first such turn, each a normal fact plus `refs: [{seq}]` (that
  thread's turns, ascending). `limit` defaults to 50, at most 200. `thread` cannot be combined
  with `about` or `project_cwds`. Without `room` it reads the main graph, so only owner surfaces,
  `tailnet:` callers, modules and all-projects agents get it; with `room`, the usual room rules.
  Evidence is kept for at most 6 turns a fact, so a fact said in many threads may not list this
  one. `mentioned_in` rows and facts about muted nodes are left out.
- `memory.correct`, `memory.merge`, `memory.split` carry `presence: { summary(input) -> string }`
  (one line, under 400 characters, no control characters, never throws). Forms: `Correct: "<fact>"
  -> "<new>" (everywhere|in <room>)`, `... is wrong`, `... ended <at>`, `Confirm: "<fact>"`,
  `Add: "<fact>"`, `Merge: "<a>" into "<b>" (everywhere)`, `Split: "<a>" (in <room>) is someone
  else`, `Split: "<a>" and "<b>" are two (everywhere)`.
- Refusals are thrown with `code: "denied"`: the main graph without a scope, an agent outside
  its grants or naming another agent, the unfiled room for a scoped agent, corrections from an
  agent or a non-owner. On a registry that passes codes through (main, b27e6ff) callers see
  `error.code === "denied"`; others still see `failed` with the same message.
- `tailnet:<login>` (set by vyred's tailnet listener) is the owner for `memory.graph`, `facts`,
  `why`, `stats` and `corrections`. `memory.corrections` has no `callers` list any more and checks
  owner surfaces and tailnet callers in the tool. `correct`, `uncorrect`, `merge` and `split` keep
  their `callers` list and also refuse any non-owner caller in the tool. `memory.relevant` is
  unchanged: tailnet callers pass a room.
- Rooms read `picks` (ids) from `projects.list`; a `threads` list of ids is still read for callers
  that pass rooms directly. Counts are ignored.
- `memory.facts`, `memory.relevant`, `memory.why`, `memory.graph` take `room` (a project slug or
  `"unfiled"`; `project` is an alias). Folders one project owns read that project's room. The
  unfiled room is refused to agents not granted every project.
- The Harness's Enrich hook sends `room: "unfiled"` when the session is in no project (it sent
  `project_cwds: [cwd]`).
- Facts and floor-plan edges carry `conflict` (true when two rooms disagree, main graph only).
- Facts carry `fresh` (0..1), `stale` (fresh under 0.35) and `seen_age`; `seen` is now the newest
  supporting turn over all evidence. `memory.relevant` results carry `fresh` and never include a
  stale fact unless its subject or object is pinned.
- `memory.stats` counts the main graph only and adds `rooms`.
- New tools `memory.correct`, `memory.corrections`, `memory.uncorrect`, `memory.merge`,
  `memory.split`, for `deck`, `cli`, `local` and `capsule` callers only. New events
  `memory.corrected {id, action, rel, scope: "all"|"project", prior_source, prior_rule,
  prior_confidence}`, `memory.merged {id, scope}`, `memory.split {id, scope}` (for Learning:
  count `prior_rule`). Facts carry `origin` (`extract`, `taught`, `user`, `confirmed`) and
  `correction: {id, action, age, note} | null`; `memory.why` returns `corrections`.
- A split node's id is `<id>#<room slug>` with the same label, so the Deck shows two "Dana Reyes".
- A caller that names no agent and no room gets the main graph from `memory.facts`, `relevant`,
  `why` and `stats` only from `deck`, `cli`, `local`, `capsule` or a module. MCP sessions pass
  `room` or `project_cwds`. The MCP server does not add either today, so an unscoped Claude call
  gets an error that says to pass one (harness team: consider sending the session's cwd).
- A folder belongs to the most specific project holding it. Agents are granted by project slug.
- `memory.correct` answers `{ correction, pending: true }` at once; `wait: true` answers
  `{ correction, facts }` after the derive. New objects are exact or new nodes of the relation's
  kind (`title:`, `date:`, `pref:`, `decision:`, `note:`).
- `fact().correction.note` and `memory.why` correction notes are null outside the scope the
  correction was made in.
- `module.json` `shows`: `{deck: ["panel:memory"], capsule: ["answer:memory.relevant"], cli: ["memory", "why"]}`.
- New relations in facts: `has_title` (object kind `title`), `client_of` (object `me:you`, label
  "you", kind `me`), `repo_for`, `deadline` (object `date:YYYY-MM-DD`, kind `date`; `until` is set
  at read time once two days past), and with the flag `prefers` (`pref:`) and `decided`
  (subject `me:you`, object `decision:`). Value kinds never match a prompt.
- Config: `memory.relations: { prefers?: boolean, decided?: boolean }`.
- `memory_aliases (room, node, alias)`: organisation spellings folded into one node because they
  share a domain. A spelling that was a node of its own is not one any more; read aliases to
  match it.
- `memory_edges` has a `room` column; any direct reader must filter `room = '*'` for the main
  graph. `memory_shortforms` has `room` in its key.

Earlier, new for dependents:

- `memory.facts {about?, project_cwds?, limit?}` returns `{ about, facts }`. `about` is the
  resolved node (`{id, label, kind, role, sessions, mentions, first, last, age, pinned, muted}`)
  or null. With `project_cwds`, facts are about what sessions in those folders (or under them)
  name, outside parties only, pinned first, muted left out.
- A fact: `{ id: "src|rel|dst", text, subject, rel, object, confidence, since, until, seen,
  age, source, ref: {session, seq, name}, evidence }`. `source` is a readable label (the
  thread's /rename name, else its first message); `age` is words ("3 weeks"); `ref` is the
  exact turn. `rel` is one of `works_at`, `has_email`,
  `has_domain`, `at_domain`, `owned_by`, `mentioned_in`. `until` is set on a closed edge.
- `memory.relevant {text, project_cwds?, limit?}` returns `[{ id, text, matched, confidence,
  age, seen, source, ref, score }]`, at most `limit` (default 5), or `[]`. Only things the text
  names count; the user's own things, tools and hubs never appear.
- `memory.why {fact, limit?}` takes a fact id or a name; returns `{ fact, turns: [{session, seq,
  name, role, ts, age, text}], gone }`.
- `memory.pin` / `memory.mute {node, scope?, off?}`: scope `*` (default) or a project folder.
- `memory.curate {full?}` returns `{ recall, sessions, turns, nodes, edges, changed, ms }`.
- Event `memory.curated {nodes, edges, ms, updated}`, only when the graph changed.
- `memory.graph {project_cwds?, around?, depth?(1..3), limit?(10..500, default 150), since?, agent?}`
  returns `{ updated, scope: "main"|"project", rooms, nodes, edges, counts, truncated }`, or
  `{ updated, unchanged: true }` when `since === updated`.
  - room: `{ id: "project:<slug>"|"project"|"shared"|"unfiled", kind: "project"|"shared"|"unfiled",
    label, slug, folders, nodes, facts }` (counts over the whole view, not the capped drawing).
  - node: `{ id, kind: person|org|name|email|domain|repo|fact|thread, label, weight, pinned,
    muted, role, room, rooms, last }`. `rooms` lists every project it is in (main graph only).
  - edge: `{ id: "src|rel|dst", src, rel, dst, confidence, since, until, learned, taught }`;
    `id` is what `memory.why` takes; `mentioned_in` joins an entity to a thread node.
- With `project_cwds`, every read (facts, relevant, why, graph) is that project's graph only.
  `memory.why` takes `project_cwds` too. Every read and steer takes an optional `agent`.
- `memory.teach {kind, fact, from}` (internal, modules only, through `ctx.memory.teach`). A
  fact: `{ subject, rel?, object?, text?, at?, key?, project_cwds?, forget? }`, where `subject` and `object`
  are a name or `{ name, email?, domain?, repo?, kind? }` (`kind` is `person` or `org`).
  Known rels: `works_at`, `has_email`, `has_domain`, `owned_by`; any other snake_case rel is
  kept as written; a subject with only `text` becomes a note. Returns `{ key, changed }`.
- `fact.project_cwds` scopes a lesson: `memory.facts {project_cwds}` and `memory.relevant
  {project_cwds}` include it when one of its folders is, or is under, a folder asked for, and
  leave it out of other projects. Without it a lesson belongs everywhere.
- Facts carry `taught: [{module, kind}]`; `memory.why` also returns `taught: [{module, kind,
  key, text, at, age}]`. `memory.stats` counts `taught`.
