# Changelog

Newest first. Every change to code lands here in the same commit. A new dependency says why.

## Unreleased

### M1 · projects and memory

#### Contracts (main)

- Recall's tables are a published contract (`core/recall/schema.js`): a turn is identified by
  `(session, seq)`, never by FTS rowid.
- `ctx.call(tool, input)`: one module uses another's tool through the rules, as `module:<name>`.
- `ctx.paths`: the `~/.vyre` paths, for modules that keep files.
- CLI commands are one file each in `core/cli/commands/`, found at run time.
- `test/fixtures/corpus.js`: the fictional corpus every M1 module tests against.

#### Recall

#### Memory

- `core/memory`: the graph and the curator, the only writer of `memory_*` tables. It reads
  Recall's tables and never runs a model. Each turn is read once by `(session, seq)` into
  observations; the graph (people, organisations, addresses, domains, repos, who works where,
  learned short forms) is derived from those and written as a difference, so a second pass
  over the same turns changes nothing.
- Edge `valid_from` is `NOT NULL`, 0 meaning atemporal. A NULL inside the unique key is what let
  the prototype append a copy of every edge on each run.
- `works_at` is voted by focus (a session's share of its organisation mentions), plus explicit
  phrasings ("Sam Okafor at Northwind Bakery") and addresses at an organisation's domain. Tools,
  hubs and the user's own organisation (from `config.me`) get no vote, because each of them
  outvoted real clients in the prototype. A move closes the old edge where the new one starts.
- Short forms ("Harlow" for Harlow Legal) are learned by measuring their precision over Recall's
  full-text index, and used only at 0.6 or above.
- Tools: `memory.facts`, `memory.relevant` (for the M2 Enrich hook), `memory.why`, `memory.pin`,
  `memory.mute`, `memory.curate`, `memory.stats`. Emits `memory.curated`; listens to
  `session.indexed` and drops a rewritten session's observations before reading it again.
- Curation runs in the background on start and shortly after each `session.indexed`, yielding
  to the event loop. With no Recall tables the module starts and answers with nothing.
- `vyre memory [about]` and `vyre why <fact>`, in the Recall gold.
- A fact's `source` is a readable label (the thread's name) and `age` is in words ("3 weeks"),
  which is what the Enrich hook and the projects brief print; the exact turn is in `ref`.
- Measured on a copy of a real 103k-turn index: first pass 6.7s, a pass with nothing new 5ms,
  one new turn 1.2s in the background; `memory.relevant` p50 0.06ms, p95 1.4ms.

#### Projects

### M0 · the skeleton (2026-09-26)

- `vyred`: one daemon per machine on a private unix socket (`~/.vyre/vyred.sock`, mode 0600).
  Refuses a second copy on the same home and clears a stale socket left by a crash.
- HTTP API under `/v1/`: `health`, `modules`, `tools`, `tools/:name`, `events`. Every response
  is `{data}` or `{error:{code,message}}`.
- Module loader: validates the five-verb manifest, starts modules in dependency order, and
  fails one module without taking the daemon down. A module can register only the tools and
  emit only the events its manifest declares.
- Every tool call, from any surface, passes through the rules hook before it runs.
- Event log in SQLite; names must read `noun.past-verb`; payloads that look like secrets are
  refused.
- Store: WAL and a 10 second busy timeout on every connection; module tables must carry the
  module's name; each migration runs once, in a transaction. The database files are mode 0600.
- `vyre` CLI: `status`, `up`, `down`, `modules`, `tools`, `call`, `version`.
- A hygiene test fails the build if shipped code names a real person or carries a key.
- No dependencies.
