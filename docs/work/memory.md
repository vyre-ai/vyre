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
- `memory.teach` and lesson provenance; paged cold derive (worst event-loop block 70 to 120ms).
- Curator, graph, module, CLI (`core/memory/`, `core/cli/commands/memory.js`), on `work/memory`.
- Every "Done when" item above holds against `seedRecall()`, including a working `memory.why`
  for every fact. Idempotency, bi-temporal and rewrite tests pass.
- Smoke run on a temp copy of a real 103k-turn index (counts and timings only): 1,581 nodes,
  6,591 edges, 842 open facts. First pass 6.7s; nothing new 5ms; one new turn 1.2s with the
  event loop never blocked more than about 180ms; `memory.relevant` p50 0.06ms, p95 1.4ms.

## Doing

## Next
- Short forms for people's first names are measured but few pass the 0.6 floor; that is by
  design. Revisit if the Enrich hook misses obvious first-name references.
- Taught facts are not scoped to a project yet: `memory.facts {project_cwds}` finds things
  through the sessions that name them, so a person known only from a lesson appears in `about`
  and `relevant`, not in a project's list. If projects wants that, a lesson could carry a
  `project_cwd`.

## Needs from others
- recall: emit `session.indexed {session, from, to, rewritten}` after each index write. Memory
  also copes without it (it compares `recall_sessions.turns` with what it has read on every pass,
  and treats a shrunk session as rewritten), but the event is what makes it prompt.
- recall: keep turn text in `recall_turns` as the contract says; Memory reads it by rowid and
  measures short forms with rowid-only `MATCH` queries.

## Changed contracts
None to other modules' contracts. New, for dependents:

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
- Event `memory.curated {nodes, edges, ms}`, only when the graph changed.
- `memory.teach {kind, fact, from}` (internal, modules only, through `ctx.memory.teach`). A
  fact: `{ subject, rel?, object?, text?, at?, key?, forget? }`, where `subject` and `object`
  are a name or `{ name, email?, domain?, repo?, kind? }` (`kind` is `person` or `org`).
  Known rels: `works_at`, `has_email`, `has_domain`, `owned_by`; any other snake_case rel is
  kept as written; a subject with only `text` becomes a note. Returns `{ key, changed }`.
- Facts carry `taught: [{module, kind}]`; `memory.why` also returns `taught: [{module, kind,
  key, text, at, age}]`. `memory.stats` counts `taught`.
