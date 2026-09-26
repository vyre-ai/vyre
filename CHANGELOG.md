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

- `core/transcripts`: the one adapter that reads Claude Code transcript files. It lists
  sessions and subagents (`<parent>/agent-<id>`), and when one session id has two files (a
  resume from another folder, an archive copy) the fullest wins, so they cannot take turns
  looking changed. It reads turns, the last `/rename`, the real cwd from the lines, and whether
  a person started it (not a subagent, not an SDK run). Tool traffic, thinking and lines Claude
  Code injects (`isMeta`) are not turns. It never throws over a bad file or line.
- The redactor is ported and runs before any text leaves the adapter: turns, titles and names.
  Placeholders keep the kind and last four characters, so "rotate the billing token" still
  finds the conversation.
- `recall` module: indexes on start and every `recall.every` minutes (default 5) in the
  background, one pass at a time, yielding between files so vyred keeps answering. Indexing is
  append-only: a grown transcript appends its new turns and keeps every vector; a rewritten one
  is indexed again from scratch; an unchanged size and mtime is not read. History outlives the
  transcript: a deleted file keeps its rows.
- Vectors are optional. With the model, turns are embedded one at a time (batching was slower
  and changed the numbers), in 900-character chunks with 200 of overlap, and a vector is written
  only if its turn still holds the text it was made from.
- Search pins the top half of the keyword answer before blending in meaning, so hybrid never
  loses an exact match; any failure of the model ends in the keyword answer. FTS5 grammar a
  person did not mean (a hyphen, half a parenthesis) falls back to the literal phrase.
- Tools `recall.search`, `recall.thread`, `recall.sessions`, `recall.index`, `recall.status`;
  event `session.indexed`; commands `vyre recall <query>` and `vyre index`.
- Under `node --test`, Recall refuses to read the real `~/.claude`, whatever the config says, so
  a test that starts vyred with default settings cannot index someone's conversations.
- Dependency: `@huggingface/transformers`, optional, because it is the only way to run the
  embedding model locally from Node; without it search is full-text and says so.

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
