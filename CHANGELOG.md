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
