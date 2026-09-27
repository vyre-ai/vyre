# memory-iq

Branch: work/memory-iq · Worktree: ../vyre-memory-iq · ADR 0023 · Owner session: memory-iq

## Scope

Memory that knows the user. Today "name of my wife" returns unrelated quotes and "which car do I
own" works only when one literal sentence matches. This workstream adds:

1. Personal facts: durable subject-relation-object facts about the user and the people and things
   in their life, extracted from every session's user turns, incrementally and in the background.
2. `memory.answer {q}`: one answer line with confidence and "from N conversations", sources on
   demand. Fact lookup first, then meaning (recall with embeddings), then keywords.
3. An eval harness on a synthetic world, run in CI.

Files owned: `core/memory/personal/*` (new), `scripts/eval-answer.js`, `test/fixtures/personal-world.js`,
`test/eval/answer-*`. Small, listed changes in `core/memory/index.js`, `core/memory/schema.js`,
`core/memory/module.json`, `core/cli/commands/memory.js` and the status command.

## Design (the contracts every task builds against)

### Storage (memory's store, one new migration in core/memory/schema.js)

- `memory_me_claims (session, seq, ts, subj, rel, obj, conf, method, PRIMARY KEY (session, seq, subj, rel, obj))`
  what one user turn says. Rewritten transcript: drop the session's rows and re-read it.
- `memory_me_cursor (session PRIMARY KEY, upto, at)` how far each session has been read.
- `memory_me_entities (id PRIMARY KEY, kind, label, first_seen, last_seen)`
- `memory_me_aliases (alias, entity, PRIMARY KEY (alias, entity))` lower-case forms that name it:
  "my wife", "wife", "jordan".
- `memory_me_facts (id PRIMARY KEY, subj, rel, obj, obj_label, confidence, first_seen, last_seen,
  mentions, sessions, current INTEGER)` derived from claims on every pass; never hand-edited.
- `memory_me_evidence (fact, session, seq, PRIMARY KEY (fact, session, seq))`
- `memory_me_budget (day TEXT PRIMARY KEY, usd REAL, calls INTEGER)` the model pass's spend.

### Claim references

`me` (the user), `kin:<role>` (an unnamed singular relative: kin:spouse, kin:mother), `name:<Name>`,
`lit:<text>` (a literal value: a date, a place), `vehicle:<Make Model>`, `place:<Name>`, `org:<Name>`,
`tool:<name>`, `pet:<name>`.

### Relations

People: `spouse`, `partner`, `mother`, `father`, `child`, `son`, `daughter`, `brother`, `sister`,
`pet`, `friend`, `colleague`. Singular roles (spouse, partner, mother, father) resolve to one
entity: "my wife", "Jordan" (once "my wife Jordan" is said) and "her" in the same breath are one.
Attributes: `name` (me|name|lit:Alex, kin:spouse|name|lit:Jordan), `birthday`, `lives_in`,
`from`, `works_at`, `role`, `owns` (vehicles and other things), `drives`, `client`, `uses`,
`prefers`.

### The reader (27 Sep; lead-approved budget)

- Every user turn with a personal signal (reader.js signal(): first person plus a life word or
  "im in X") waits in memory_me_queue, keyed by the hash of the text and VERSION. The fast model
  (config.models.memory, then .background, then config.memory.model.model, then haiku) reads 20
  at a time through `claude -p` (no tools, MCP, settings or session kept), newest first.
- Budget: config.memory.model {on, dailyUsd 0.25, backfillUsd 2 (one-time pool), batch 20, gapMs
  >= 60 s}. It runs on events only, never while a user thread works. Spend is what the runner
  reports. The usage line is memory.read and `vyre status`.
- Check (checkRead): the quote must be in ownText(turn), and the subject and object must be
  said there. Relations are the vocabulary of model.js plus sold (-> ended:owns) and color (a
  vehicle's). method "model", at most 0.8. Kept in memory_me_reads by hash, so it is applied
  again with no call.
- Eval: test/eval/reads/<world>.json replays the reads. `--record` records them with `claude -p`
  (testbox), and the sealed world is recorded without anyone reading the file.

### Round 1 additions (27 Sep, the contract both halves build against)

- Relations: `diet` (me|diet|lit:vegetarian; single-valued), `breed` (a pet|breed|lit:beagle;
  single-valued), `friend` (me|friend|kin:friend or name:<Name>, many). A relative's own
  attributes use the existing relations with the relative as subject: kin:spouse|role|lit:nurse,
  kin:mother|lives_in|place:Tucson, kin:spouse|works_at|org:<Org>.
- Kin words gain friend: friend, buddy, mate (only as "my mate"), pal, bestie -> role `friend`
  (not singular: each named friend is name:<Name>).
- Vehicles: trucks, vans, motorbikes are vehicles; owns/drives/ended:owns as for cars.
- Answer kinds: `of {who: {kin?|name?}, rel}` (a relative's or named person's attribute),
  `diet`, `car` also for truck/van/suv/pickup/bike, `carFate {car}` ("what happened to the
  outback"), friend questions through `kin` with role friend.
- Evaluation discipline: rules are written for the general phrasing with the agent's own varied
  test sentences, never by copying a world's sentence. test/fixtures/personal-fresh.js and
  test/eval/answer-fresh.json are SEALED: never opened, only scored.

### Confidence

Per claim by method: explicit rule 0.9, indirect rule 0.7, model 0.75, assistant's words 0.35.
Combined per fact as 1 - prod(1 - c), then scaled by its share against rival values for a
single-valued relation (a spouse's name, a birthday, where the user lives: newest wins ties).
memory.answer answers at confidence 0.5 or more, says "maybe" from 0.3, and says nothing under.

### memory.answer

Input `{ q, project_cwds?, room?, sources?: boolean }`. Output
`{ answer: string|null, confidence: number|null, kind: "fact"|"said"|null, from: number (conversations),
   facts: [{ id, subject, rel, object, confidence, sessions, first_seen, last_seen }],
   sources: [{ session, seq, name, quote, ts }], via: "fact"|"meaning"|"keyword"|null, ms }`.
Callers: the user's surfaces (deck, cli, local, capsule), the user's tailnet devices, modules, and
the assistant or an agent granted every project. A project-scoped agent is refused: personal
facts are not a project's.

### memory.profile and memory.remember (for cc-plugin's about.md and /vyre remember)

- `memory.profile {limit?: 1..50 = 12}` -> `{ facts: [{ text, kind: person|place|vehicle|work|client|preference|other, weight, id, rel, from }] }`.
  Second-person lines, current and at weight 0.5 or more. No birthdays or dates, and nothing that
  looks like an account number, phone, street address, email or health.
- `memory.remember {text, room?}` -> `{ id, text, facts: [{ id, subject, rel, object, confidence }] }`.
  No prompt (the no-nag rule). The text is stored in `memory_me_told` and read as session `told:<id>`
  by the same rules at 0.95 (indirect claims at 0.8). In a single-valued slot it outweighs every
  older value (x0.1). A full re-read keeps it. A line with no facts is still found by its words.
- Same gate for answer, profile and remember (personalOnly in core/memory/index.js). A bare "mcp"
  caller is the user's own Claude Code session and passes, in any folder (27 Sep, for cc-plugin).

## Done
- T1 eval world + harness (8c188bc). Held-out world + `--world heldout` (23d25ac).
- T2 extraction + store (fb98555). T3 model pass with daily cap (adc1a94, wired 23d25ac).
- T4 memory.answer (f1b4512), CLI `vyre memory ask`.
- memory.profile and memory.remember (892b339). Contracts sent to cc-plugin on 27 Sep.
- Eval 27 Sep on testbox: gold world overall 1.0, p95 10.8 ms. Held-out world overall 0.277,
  precision 0.057, 4 confident wrong (the husband answered as "Claire", Owen's wife from a
  pasted email). The held-out world is the real number.

## Doing (27 Sep, after LOGOUT 4; ADR 0034 approved with amendments)
- DONE this session, on work/memory-iq (handed to the integrator at 0f0c17a2):
  - A temp, dev or trial home never reads the person's ~/.claude (core/recall/index.js readable(),
    on e2e's claudeHome and guard test). This is how the trial Capsule got "Jordan".
  - Source trust: core/memory/personal/trust.js plus the memory_me_trust migration. Only the user's
    own words teach personal facts. No Claude turns, subagents, headless runs, Capsule asks, Vyre
    folders, sessions about building memory (2 turns with DEV words), skipCwds, or harness blocks.
    The said path is filtered the same way.
  - Eval: `--world trust` (the Jordan trap) at 1.0. Every question is asked 3 times
    (inconsistent 0 everywhere) and ungrounded is counted (0 everywhere). Both are in BAR.
  - People bar PEOPLE_SURE 0.6, from a sweep over 0.5 to 0.75 in which no world moved. Yes/no
    questions about a relative ("does my wife like hiking") abstain.
- After 0f0c17a2 (WIP, not yet handed over): a sold thing was owned (ended:owns -> owns, and the
  object is the user's entity); DEV words narrowed ("seed data" is a dev job's, not memory's);
  Claude's turns still set pronoun focus; memory.retrieve (core/memory/iq/retrieve.js) and
  scripts/eval-iq.js (phase 2, ablations bm25/hybrid/dense/+expand/+when/full, recall@8).
- Scores now (replayed reads): personal 1.0, heldout 1.0, blind 0.959, fresh 0.76, trust 1.0, sealed
  0.551 with 7 confident wrong. Before this session sealed was 0.577 with 6. Two sealed answers
  were lost because Claude's words no longer count: a past home that only Claude had named, and a
  brother's home read in the same batch that first learned his name. The past-home one is now a
  confident wrong answer (two model lives_in facts, and the older one is not picked for "before").
  Not tuned on sealed.
- Sessions worlds: test/fixtures/iq-sealed.js (61 sessions, 100 q, written blind and never opened;
  only counts were checked) and iq-open.js (52 sessions, 90 q, tuning).

## Next
- The real-embedder ablation numbers into ADR 0034 (running on testbox: VYRE_EVAL_EMBEDDER_DIR
  under ~/vyre-ci/miq-embedder).
- Phase 3: memory.ask, the answer step (fast model, JSON with citations, names and numbers checked
  by code, abstain), replayed in CI from recorded calls. Then phase 4 (second look, answer cache by
  fact-set version).
- Cohesion (agreed 27 Sep): memory.suggest {prefix, context} under 25 ms; recall.search {prefix}
  (FTS5 term*), as a listed change since recall has no active team; memory.ask context.
- "Before" for places: pick the newest place before the current one.
- Full backfill cost for the user: about $0.65 per 1,000 user turns (2 readings plus the second
  look). The repo's recall notes count about 3,900 user turns on the real corpus, minus the dev
  sessions now left out: about $1.50 to $2.60. The $2 pool covers most of it, and the $0.25/day
  cap finishes the rest in 1 to 3 days.

## Needs from others
- main: OK a fast-model (haiku) extraction pass over every personal-signal user turn (a one-time
  backfill of about $2, then about $0.25/day, configurable), and recording eval fixtures with `claude -p`.
- sessions: the per-purpose model map location and the one-shot background job call. Also
  per-turn memory.answer or a combined memory.context tool (message sent 27 Sep).
- polish-cli: the contract of the low-priority index worker. Until then extraction runs in the
  memory curator's background pass, in bounded batches that yield.

## Changed contracts
- core/recall/index.js readable(folders, root, env): the person's ~/.claude only for the real ~/.vyre (or VYRE_ALLOW_REAL_TRANSCRIPTS=1). New tool memory.retrieve. Table memory_me_trust. Config memory.personal.skipCwds.
- New tools `memory.answer`, `memory.profile`, `memory.remember` (see above); event `memory.remembered`; table `memory_me_told`. New table family `memory_me_*` (memory's own).
