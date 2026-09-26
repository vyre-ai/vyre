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
- `core/transcripts/` adapter and redactor (51a65b4).
- `core/recall/` module: append-only indexer, vectors, hybrid search, five tools, `session.indexed` (7b75f8c).
- `vyre recall <query>`, `vyre index` (6ce43c8).
- `@huggingface/transformers` as an optional dependency; everything works and tests pass without it.
- Done-when: the corpus indexes to exactly `seedRecall()`'s rows; grown and rewritten tests pass;
  the read-only smoke run over the real transcripts completed, 26 Sep 2026, temp VYRE_HOME:
  613 sessions, 23,389 turns. `vyre up` returned in 0.56s; the first pass finished in the
  background in about 8.7s, and a second pass in 0.94s (610 skipped, 3 live sessions appended).
  All 23,389 turns embedded in about 13 minutes (about 30 turns a second, model load 6.7s).
  Search through the socket: keyword p50 19ms, max 51ms; hybrid warm p50 68ms, max 175ms.
  `recall.thread` 29ms. Database 192MB with vectors.

- Dense retrieval: meaning is a way into the pool, not only a re-ranker (566c922), built in
  the background (71bf215), with a floor that rises with corpus size; download shown in
  `vyre status` (22e5035). Real corpus, 26 Sep 2026: 23,779 turns, 37,160 chunks, dense index
  57MB, built in 1.05s in the background. Hybrid through the socket p50 41ms, p95 60ms, first
  query 83ms; keyword p50 13ms. Dense scan alone 19ms.

## Doing
- Nothing in progress.

## Next
- Measure MRR again on the real corpus. There is no eval harness in the prototype folder (the
  0.195 against 0.142 figure is only quoted in SPEC.md), so one needs writing: labelled queries
  with a known answer turn, keyword against hybrid.
- The dense index is rebuilt whole after any pass that wrote turns. Appending the new vectors
  in place would save a 1 to 6 second background rebuild per active pass.
- The floor was fitted on two corpora and the margin at 37k chunks is a few hundredths. Worth
  re-checking with labelled queries once an eval harness exists.
- A grown transcript is still read in full. Reading only the bytes after the last indexed size
  would make passes over one very large live session cheaper.
- `recall_turns` has no index on `session` (FTS5 UNINDEXED), so `recall.thread` and the append
  check scan the table. Fine at 25k turns (thread in ~30ms); watch it at 100k+.

## Needs from others
- memory: listen for `session.indexed`. `from` and `to` are INCLUSIVE seqs. When `rewritten` is
  true, every earlier (session, seq) for that session is gone and seqs restart at 0; drop or
  re-check evidence for it. A pass with no new turns emits nothing.
- projects: the catalogue can read `recall_sessions` directly, or call `recall.sessions`.
  `recall.search` takes `project_cwds` and matches a session whose cwd is one of them or inside
  one (`/a/b` matches `/a/b` and `/a/b/c`, not `/a/bc`). Sessions for deleted transcripts stay in
  the index on purpose.
- main: a decision to confirm. When the optional package is installed, the model weights (23MB)
  are fetched from Hugging Face on first use into `~/.vyre/models`, unless `recall.download` is
  false. The fetch carries nothing about the user, but it is a network call; see principle 2.
- anyone starting vyred in tests: point `transcripts` at fixtures in config.json. Under
  `node --test` Recall drops folders inside the real `~/.claude` anyway.

## Changed contracts
- No schema change: `core/recall/schema.js` is untouched.
- `recall.search` input also takes `per_session` (max hits from one session; default 3, 0 means
  no cap). Hits carry exactly the ten documented fields; `score` is higher-is-better, in [0,1].
  `snippet` marks matched words with « and ».
- `recall.index` returns the five documented fields plus `added`, `failed` and `turns`. It
  resolves to null if vyred is stopping.
- `recall.status` returns `{ sessions, turns, folders, every, indexing, last, error,
  vectors: { on, why, embedded, pending, embedding, dense } }`. `dense` is `{ chunks, bytes, ms }`
  once built, else null. While the weights download, `why` starts with "downloading".
- `recall.search` scores are now reciprocal-rank, normalised to [0,1], higher is better. The
  undocumented `weight` input is gone.
- `recall_meta` row `generation` (no schema change): bumped whenever the indexer deletes turns.
  Anything that caches turns by (session, seq) can compare it to know its copy went stale.
- A turn is a user or assistant line with text parts. Tool results, tool calls, thinking and
  `isMeta` lines are not turns (the prototype indexed tool results as user turns).
- `human` is 0 for sidechains, any `entrypoint` starting with `sdk`, and every subagent file.
- Config keys under `recall`: `every`, `vectors`, `download`, `models`.
