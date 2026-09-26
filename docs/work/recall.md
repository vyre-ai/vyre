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

- Eval harness: `recall.eval` and `vyre recall eval <file>` (a5c7e60). Runs a labelled set
  (question, answer turns) three ways — keyword, dense, hybrid — and reports MRR@10 and
  recall@10, plus the dense floor checked from both sides. `test/fixtures/recall-eval.json` is
  a fictional set on the fixture corpus (14 questions, 23 answer turns), fictional set numbers:
  keyword MRR 0.667/recall 0.714, dense 0.643/0.571, hybrid 0.845/0.821; floor 0.277, best
  nonsense 0.186 (clean margin).

- Dense index appends new vectors in place instead of rebuilding (ede58f1); a rewrite still
  rebuilds. Verified by a dedicated test (`dense.builds` stays at 1 across appends, moves to 2
  only after a rewrite).

- Real-corpus eval, 26 Sep 2026, temp VYRE_HOME, 743 sessions / 24,557 turns / 38,583 dense
  chunks. Labelled set built from the real index with exactly one `claude -p --model haiku`
  call (150 passages in one prompt, run in `/tmp/vyre-lab` with its own temp `VYRE_HOME`; kept
  outside the repo at `/private/tmp/claude-501/vyre-recall-eval/labelled.json`): 97 questions,
  30 nonsense probes.
  - keyword: MRR 0.572, recall@10 0.866
  - dense: MRR 0.327, recall@10 0.515
  - hybrid: MRR 0.544, recall@10 0.856 (current defaults: floor 0.445, dense_weight 0.25)
  - floor 0.445 at 38,583 chunks: 38/97 answers score below it (meaning alone can't reach them;
    keyword and hybrid still do). Weakest answer decile 0.325.
  - nonsense: 1 of 30 probes cleared the floor (top score 0.494 against floor 0.445); 25/30
    returned some keyword hit (expected: loose OR-of-words matching common words), 0 reached
    the top of a hybrid result in a way that mattered in a manual spot check.
  - dense_weight sweep at floor 0.445 (hybrid MRR / recall@10): 0.15 → 0.560/0.876, 0.25
    (shipped) → 0.544/0.856, 0.5 → 0.510/0.845, 1 → 0.485/0.763. Lower weight scored best on
    this one labelled batch; not switched on a single run's numbers.
  - floor sweep at dense_weight 0.25 (answers below floor / nonsense over floor): 0.40 → 30/97,
    5/30; 0.444 → 38/97, 1/30; 0.48 → 47/97, 1/30; 0.50 → 51/97, 0/30 clean.

- Diagnosis: why hybrid ties or trails keyword on the real corpus but wins clearly on the
  fictional set (26 Sep 2026, after merging perf's dense-index chunk cap, bd92c62). Measured
  with the eval harness against the real labelled set (743 sessions / 24,557 turns / 38,583
  chunks) unless noted; the fixture set is 14 questions / 16 chunks.
  - **Assistant-only turns** (docs/SPEC.md 7.3 measured dense search over assistant turns; the
    shipped indexer embeds both roles). Restricting the DENSE side to assistant-role turns (no
    re-embedding needed — the stored vectors already carry role) raised real-corpus dense-only
    MRR 0.327 → 0.359 and hybrid (at retuned dense_weight, see below) MRR 0.544 → 0.61, recall
    0.856 → 0.876. Real corpus: 3,903 user turns (short commands, one-line corrections, pasted
    errors, median 271 chars but a heavy tail of noise) sit in the same 384-dim space as 20,654
    assistant turns of actual explanation, diluting it. **Rejected as an index-time exclusion**:
    it drops the fictional set's hybrid MRR from 0.845 to 0.667, because the fixture's own
    dense-only case ("blind visitors" → an accessibility audit) is answered by a USER turn with
    no assistant turn standing in for it, and `recall: meaning alone finds a turn that shares no
    word with the question` fails outright. Tried as a soft score multiplier instead (`userWeight`
    on dense.js `search`, still exported, default 1/off): a weight strong enough to matter on the
    real corpus (0.5-0.7) also sinks the fixture's one relevant vector below its floor at any
    weight under about 0.82, at which point it does nothing on the real corpus either — the
    fixture corpus is too small to survive de-emphasis and too small to retune against. Left off.
  - **Rank-fusion k**: made configurable (`rrf_k`, search.js). Swept 10/20/30/60/100 at
    dense_weight 0.05/0.08 on the assistant-only variant: 60 (the shipped constant) was already
    best or tied-best at every dense_weight tried; not changed.
  - **Query length**: the real labelled set (haiku-generated, "5 to 12 words") came out 5-8
    words with almost no spread (p25/median/p75 all 6). Not a usable signal to test a
    length-dependent dropoff against; deferred until a labelled set with real length variance
    exists.
  - **Tool noise in turns**: not applicable as scoped — `transcripts.turnOf` (core/transcripts/
    index.js) already keeps only `type: "text"` content parts; tool_use, tool_result, thinking
    and isMeta lines are excluded before a turn exists at all (see the `transcripts: tool
    traffic, thinking and lines Claude Code adds are not turns` test). No further stripping
    attempted.
  - **Chunking granularity**: not changed. 900/200 (embed.js) already puts ~90% of turns in one
    chunk; assistant turns average 1.46 chunks each on the real corpus. Not investigated further
    given the clearer win below; worth a dedicated pass later if the fixture-size ceiling on
    dense_weight gets revisited.

- Fixes shipped, measured on both sets:
  - **Agreement-gated floor** (search.js `search`): the dense floor now only gates the
    DENSE-ONLY reach. A candidate keyword also matched is admitted at whatever rank meaning gave
    it, floor or no floor; the floor decides only whether a turn with no keyword agreement at
    all is allowed into the pool on meaning alone. Implemented by having `dense.search` return
    everything unfiltered (`floor: -1`) plus population stats (mean/std of this query's own dot
    products, attached non-enumerably as `.stats`) and applying the floor only to candidates not
    already in the keyword pool. This alone (no other change) raised fictional hybrid MRR 0.845
    → 0.881 (recall unchanged, 0.821) and real hybrid MRR 0.544 → 0.549, recall 0.856 → 0.887.
    No regression on either set — this is why it shipped unconditionally.
  - **`dense_weight` retune, gated by "must not regress the fictional set"**: with agreement
    gating in place, swept 0.05/0.1/0.15/0.25/0.5 on the real corpus (USER_WEIGHT 1): MRR/recall
    were 0.58/0.866 at 0.05, 0.57/0.876 at 0.1, 0.56/0.887 at 0.15, 0.549/0.887 at 0.25 (shipped),
    0.549 held through 0.5 too. Recall keeps climbing with dense_weight; MRR falls. On the
    FICTIONAL set, every value under 0.25 dropped hybrid MRR from 0.881 to 0.81 — a step, not a
    slope, so it reads as a rank-order threshold in a 16-chunk index rather than a smooth cost.
    Kept at 0.25: it is the highest-recall, lowest-regression-risk point that does not cross that
    step. **Left on the table**: 0.05 gets real hybrid MRR (0.58) past keyword's (0.572) outright,
    at the cost of the fictional set's threshold. Revisit if the fictional set grows past the
    point where one flip in one ranking swings its whole MRR.
  - Net real-corpus result at shipped defaults (dense_weight 0.25, `z` off, USER_WEIGHT 1):
    keyword 0.572/0.866, dense 0.327/0.515, hybrid 0.549/0.887. Hybrid recall now beats keyword's
    (0.887 vs 0.866); hybrid MRR is closer to keyword's than before (0.549 vs the old 0.544) but
    still trails it (0.572) under the no-fictional-regression constraint. Fictional set: keyword
    0.667/0.714, dense 0.643/0.571, hybrid 0.881/0.821 (up from 0.845/0.821, no regression).

- Floor mechanism: tried a per-query relative floor (`z`, search.js/dense.js: `mean + z * stddev`
  of THIS query's own dot products across the corpus, computed in the same scan dense.search
  already does, no extra pass over the vectors) instead of `floorFor(n)`'s single constant fit
  to corpus size. Swept z = 1..8 on the real corpus (dense_weight 0.05, `floor` forced to 0 so
  only z gates): nonsense false-positive rate barely moved from 30/30 clearing at z=1-3 to 29/30
  at z=4, then real answers started dying disproportionately (18/30 nonsense clear at z=5, but
  51/97 real answers now score below the gate; 0/30 nonsense at z=8, but 94/97 real answers do).
  No z value found a clean separation this labelled set's overlap does not already forbid: the
  single highest-scoring nonsense probe ("how to fold a paper crane", 0.494) sits ABOVE several
  real answers' own best score (as low as 0.376) in absolute terms, per-query z-score or not —
  natural-sounding nonsense and a weak real answer are not reliably separable by SCORE alone on
  this batch. `Z` ships as `undefined` (off) for that reason; agreement gating above is the part
  of "make the floor more robust" that measurably helped. **False-positive rate: unchanged from
  before, 1/30** (`floorFor(n)` at 38,583 chunks, same as the pre-existing measurement) — the
  fixed floor's value was not changed, only where it applies.

- Quantization (for perf, blocking on nothing else in this pass): measured, not implemented.
  Real component values from the model are small (min -0.252, max 0.272 sampled over 3,000
  vectors; mean |component| 0.041 against DIM 384). A fixed symmetric int8 quantizer (range
  ±0.3, scale 0.3/127) round-tripped through quantize→dequantize gives max per-component error
  0.0012, RMS relative error 1.3%. Retrieval quality on the real labelled set, float32 vs that
  quantize-dequantize round trip, same vectors, same scan: MRR 0.374 → 0.373, recall@10 0.577 →
  0.577 (assistant-only chunk set, 30,232 chunks; the exact quantizer script is outside the repo
  at `/private/tmp/claude-501/vyre-recall-eval/quant-check.mjs`, not wired into dense.js or
  schema.js). Quality loss is noise-level. **Deferred, not shipped**: storing int8 instead of
  float32 in `recall_vectors` changes the column's byte format, which is a `schema.js` contract
  change (this branch's own scope note: change schema.js "only with a new migration step") and
  touches the append/read/build path end to end (embed.js's `encode`/`decode`, indexer.js's
  `vectorize`, dense.js's `read`/`add`, plus a migration to re-encode or re-embed every existing
  vector). That is more than fits alongside the floor and weighting work in this pass without
  rushing the migration. Perf's number stands: ~4x memory per chunk (1,553B → ~404B) at
  effectively no retrieval cost, so `DEFAULT_MAX_CHUNKS` could go roughly 4x higher for the same
  budget once someone does the storage-format change properly.

- Post-merge sanity check (after picking up main's model-download-skip-under-`node --test` fix,
  0684098): re-ran both eval scripts unchanged. Real corpus: keyword 0.572/0.866, dense
  0.327/0.515, hybrid 0.549/0.887, floor 0.445 (38/97 below, nonsenseTop 0.494), nonsense
  1/30 — bit-for-bit the numbers already in this file. Fictional set: keyword 0.667/0.714,
  dense 0.643/0.571, hybrid 0.881/0.821 — also unchanged. The fix only touches the module's own
  background-indexing start path (`core/recall/index.js`'s `NODE_TEST_CONTEXT` guard); the eval
  scripts call `embed.js`'s `load()` directly with `download: false` against an already-built
  temp home, so it was never in the download path measured here. No regression, as expected.

- **Rank-fusion k, retuned on the SHIPPED index** (not the rejected assistant-only variant this
  branch tried it on before): a differential pass comparing keyword-only vs hybrid rankings
  per query on the real labelled set turned up 23 "keyword wins" where the keyword-only search
  put the answer at rank 0 but hybrid pushed it down (seen as far as rank 9), against only 22
  genuine "hybrid wins". The `search()` scoring formula explains it: at `rrf_k` 60 and
  `dense_weight` 0.25, a candidate keyword ranks 5th but dense ranks 1st scores HIGHER
  (normalized 0.94) than the true top keyword answer sitting alone with no dense agreement
  (0.8) — a weaker keyword match riding dense agreement can outscore the correct top keyword
  hit. A smaller `rrf_k` sharpens both lists' top ranks relative to their tails, which fixes
  this without touching `dense_weight`. Swept `rrf_k` in {5,8,10,12,20,30,45,60,80,100} x
  `dense_weight` in {0.15,0.2,0.25,0.3,0.35} on the real corpus, cross-checked against the
  fictional set every cell (must not regress either). Best point: **`rrf_k` 10, `dense_weight`
  0.25 (unchanged)** — real hybrid MRR 0.549 → 0.597, recall@10 0.887 → 0.897; fictional hybrid
  MRR/recall unchanged at 0.881/0.821; nonsense false-positive rate unchanged at 1/30 (the floor
  does not depend on `rrf_k`). Verified directly: the two regressed queries from the
  differential pass ("session state git log history refresh", "transcript cleanup
  non-conversational record removal") both return to rank 0 at `rrf_k` 10. **This is the first
  change in this pass that clears keyword's own real-corpus MRR (0.572) outright, not just
  keyword's recall.** Shipped as the new `RRF` constant in search.js. All 38 `core/recall/*`
  tests pass unchanged (no test asserts the exact constant).

- Other fresh angles tried this pass, no further change shipped:
  - **Gentler role weight, and whether the fictional dense-only case is actually immovable**:
    re-read the fixture's "blind visitors" case (`test/fixtures/recall-eval.json`) closely — its
    `answers` array lists BOTH the user turn (seq 0, the accessibility-audit request) and the
    assistant turn (seq 1, "the email field has no label, and the submit button has no focus
    ring") as valid hits, so the eval harness's own MRR/recall already credit a hit on the
    assistant turn. Swept `user_weight` finely (1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5) against
    just the fixture set: hybrid MRR/recall hold at 0.881/0.821 through 0.85, then drop to
    0.774/0.786 at 0.8 (matches the earlier "fails under about 0.82" finding almost exactly).
    So the gentle end (0.85-1.0) is provably safe on the fixture set. It just isn't gentle
    enough to move the real corpus: at `rrf_k` 60 the real-corpus effect of `user_weight` only
    showed up at 0.5-0.7 (recall.md, "Diagnosis" section); 0.85-0.95 is too close to 1 to matter
    there either. Left off (default 1, still an eval-only knob) — not because the fixture case
    is immovable (it survives further than previously stated) but because the range that
    survives the fixture doesn't do anything on the real corpus, and the range that does
    anything on the real corpus doesn't survive the fixture. The `rrf_k` retune above already
    got past keyword without needing this lever.
  - **RRF blend ratio (`dense_weight`) beyond the existing sweep**: re-swept 0.15-0.35 in 0.05
    steps against the new `rrf_k` values above (not just against the old `rrf_k` 60). At
    `rrf_k` 10, `dense_weight` 0.2 regresses the fictional set (0.81, a step down from 0.881)
    the same way lower values always have; 0.25 is still the highest point that doesn't cross
    that step; 0.3 holds the fictional set but real MRR is lower (0.582) than at 0.25 (0.597).
    0.25 remains the best blend ratio, now paired with the retuned `rrf_k`.
  - **Keyword search itself**: looked for stemming/tokenization false negatives (the schema
    already uses `tokenize='porter unicode61'`, so basic stemming is in) by dumping every query
    where keyword-only search missed all its answers entirely (13 of 97). Every one of them is
    a genuine semantic-gap question with no shared words at all against its answer text (e.g.
    "anniversary surprise scavenger hunt trip planning" -> an answer about a Thailand trip and
    Sept 1 falling on a Tuesday) — not a tokenization bug. Confirmed one of these ("real Google
    ratings per office location") is NOT actually an unrecoverable miss: dense finds it at rank
    0 (score 0.633, comfortably over the 0.445 floor) and hybrid surfaces it at rank 6 via
    agreement-gating, which is dense doing exactly the job the design doc says only meaning can
    do. No keyword-side change made; the real bottleneck for the remaining misses is dense
    ranking, not tokenization.

- Quantization, float16 alongside the existing int8 measurement (same vectors, same scan, same
  labelled set, assistant-only 30,232-chunk set): a manual IEEE754 half-precision pack/unpack
  round trip (portable across Node versions, no `Float16Array` dependency) gives max
  per-component error 0.00023, RMS relative error 0.041% — about 32x smaller error than int8's
  1.3%. Retrieval quality, side by side:

  | | max component err | RMS rel err | MRR | recall@10 |
  |---|---|---|---|---|
  | float32 (baseline) | — | — | 0.374 | 0.577 |
  | int8 quant-dequant | 0.0012 | 1.3% | 0.373 | 0.577 |
  | float16 quant-dequant | 0.00023 | 0.041% | 0.374 | 0.577 |

  float16 is retrieval-lossless at this precision (MRR/recall identical to float32 to three
  decimal places); int8's loss was already noise-level and stays so. Script at
  `/private/tmp/claude-501/vyre-recall-eval/quant-check-f16.mjs` (outside the repo, not wired
  into dense.js/schema.js/embed.js). **Not shipped**: float16 is a simpler, stdlib-friendly 2x
  reduction (1,553B -> ~777B/chunk) versus int8's 4x, and easier to justify given the near-zero
  measured loss, but it is still the same `schema.js`-contract, end-to-end storage-format change
  (embed.js encode/decode, indexer.js vectorize, dense.js read/add, a migration) that int8 was
  deferred for, and other in-flight branches are touching the index format; shipping either one
  behind a flag now risks a collision this pass has no way to see coming. Perf's question is
  answered either way: both formats are safe on quality; float16 is the easier one to justify
  shipping when someone owns the storage-format change properly.

## Doing
- Nothing in progress.

## Next
- Storage-format quantization (float16 or int8) is measured and safe on quality (see above) but
  unstarted as an actual change: it needs `schema.js`, `embed.js`, `indexer.js`, `dense.js` and
  a migration, touched together, ideally by whoever owns the index-format work other branches
  are also touching right now.
- The dense-only floor's false-positive rate (1/30 real nonsense probes) is unchanged from
  before this pass; see "Floor mechanism" above for what was tried (per-query z-score) and why
  it did not ship. A cleaner fix likely needs either a labelled set where natural-sounding
  nonsense and weak real answers do not overlap in score, or a signal other than the dense score
  itself (e.g. how many OTHER turns in the corpus score nearly as high — a flat top suggests no
  real match, a lone spike suggests one).
- The fictional/synthetic labelled set (14 questions, 16 chunks) is now the binding constraint
  on `dense_weight`: a value that would clearly beat keyword on the real corpus (0.05) cannot
  ship because it drops the fictional set's hybrid MRR by a full rank position. Growing that set
  (more questions, not necessarily a bigger corpus) would make its MRR less sensitive to any one
  ranking and might unblock the lower value.
- int8 quantization: numbers are in hand (see above) and look safe; the actual storage-format
  change (schema.js, embed.js, indexer.js, dense.js, a migration) is unstarted.
- The floor margin does not fully hold anymore: at the current cap (0.45) and this corpus size,
  1 of 30 nonsense probes scored above the floor. Raising the floor to 0.5 (above the current
  hardcoded cap) makes the nonsense set clean but pushes 51/97 real answers below it instead of
  38 — those answers stay findable through keyword, since the floor only gates the dense-only
  reach, but the margin the design doc counted on ("a few hundredths") is gone at this size with
  a 30-probe nonsense set (the 15-probe run that fit the cap saw none clear it). Worth deciding
  whether to raise the cap, weight nonsense more heavily than nulls in the fit, or accept it.
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
- `dense.js` `Dense#search` takes two new options: `z` (a per-query relative floor on top of the
  absolute one; off unless given) and `userWeight` (scales a user-role turn's score before
  ranking; default 1, unused in production — ships off, see "Floor mechanism" above). Its
  returned array now carries a non-enumerable `.stats` (`{ mean, std, n, effectiveFloor }`) for
  callers that want it; it still serializes and iterates as a plain hit list.
- `recall.search`'s internal `search()` (search.js) gained two more eval-only knobs alongside
  the existing `floor`/`dense_weight`: `rrf_k` (the reciprocal-rank constant, default `RRF`,
  retuned from 60 to 10 this pass, see "Rank-fusion k" above) and `z`/`user_weight` (passed
  through to `dense.search`, both off by default). None of these are part of `recall.search`'s
  documented tool input.
- The dense floor is now agreement-gated rather than a bare cutoff: a candidate the KEYWORD side
  also found is admitted regardless of its dense score; the floor applies only to a turn that is
  in the pool on meaning alone. See "Fixes shipped" above for the numbers.
