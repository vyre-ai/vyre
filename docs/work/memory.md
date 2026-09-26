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
## Doing
## Next
## Needs from others
## Changed contracts
