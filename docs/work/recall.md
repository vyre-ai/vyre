# recall

Branch: work/recall · Worktree: ../vyre-recall · Milestone: M1

## Scope

Owns `core/transcripts/`, `core/recall/` (except `schema.js`, which is a contract: change it only
with a new migration step and a note below), `core/cli/commands/recall.js`.

- **transcripts** (not a module, a library only Recall imports): the ONE place that reads Claude
  Code transcript files (spec principle 1). Lists transcripts under `config.transcripts`,
  including subagents at `<folder>/<parent>/subagents/agent-<id>.jsonl` (Vyre id
  `<parent>/agent-<id>`). Parses turns, the last `custom-title` (the /rename name), the real
  cwd from the lines, `human` (0 for sidechains and `entrypoint: sdk-cli`), `parent`. Redacts
  secrets before anything leaves it (port `the prototype's bin/sanitize.cjs`). Degrades to "no history"
  on a missing folder or a bad line; never throws for a bad file.
- **recall** module: indexes into the schema tables. APPEND-ONLY: a grown transcript appends
  its new turns and keeps every existing vector; a rewritten one (the first indexed turns no
  longer match) is re-indexed from scratch. Size+mtime unchanged means skip. Vectors are
  optional: embeddings via `@huggingface/transformers` (all-MiniLM-L6-v2, int8) as an
  `optionalDependencies` entry, loaded lazily; without it Recall is full-text only and says so.
  Embed one turn at a time (see the measurements in `the prototype's bin/embed.cjs`), chunk 900/200.
  Before writing a vector, check the turn still exists (a re-index can delete it mid-embed).
- Indexes on start and then every `config.recall.every` minutes (default 5) in the background,
  never blocking vyred's startup; one run at a time.

## Tools (module `recall`)

- `recall.search {q, limit?, project_cwds?: string[], role?, hybrid?}` → `[{session, seq, role, ts, text, snippet, score, name, title, cwd}]`
- `recall.thread {session, from?, limit?}` → the session row and its turns
- `recall.sessions {cwd?, since?, human?, limit?}` → session rows, newest first
- `recall.index {}` → runs an index pass now: `{sessions, appended, reindexed, skipped, ms}`
- `recall.status {}` → counts, last run, vectors on or off and why

## Events (emitted)

- `session.indexed {session, from, to, rewritten}`: seq range written. Memory listens to this.

## CLI

`vyre recall <query>` (search, readable output, name or title per hit), `vyre index`.

## Port from

`the prototype's bin/recall.cjs`, `transcript.cjs` (parsing parts only), `sanitize.cjs`, `embed.cjs`;
tests in `the prototype's bin/test/t-recall-append.cjs`, `t-session-names.cjs` and any recall/sanitize tests.

## Done when

- Indexing `writeTranscripts()` from `test/fixtures/corpus.js` yields exactly `seedRecall()`'s rows.
- Grown-transcript test: vectors survive; rewritten-transcript test: full re-index.
- A read-only smoke run over the real `~/.claude/projects` with a temp VYRE_HOME, reporting only
  counts and timings (never content), completes.

## Done
## Doing
## Next
## Needs from others
## Changed contracts
