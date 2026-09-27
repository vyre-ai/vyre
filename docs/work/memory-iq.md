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

## Doing
- The reader (4a361881, WIP, untested because of the testbox freeze). Next on testbox:
  reader.test.js, the personal suite, daemon.test.js, docs:ref (new tool memory.read) and a
  single `claude -p` smoke call. Then record reads for personal/heldout/blind/fresh, score all
  four and report fresh and the cost per 1,000 turns to main.
- Extraction round 1 is WIP at 37c10f86, untested, its subagent interrupted by the user. Review it
  with the same test run.

## Next
- Model-backed answering with evidence (asked by the lead): too slow for memory.answer's 150 ms
  bar, so a separate `deep` path the Capsule can call when there's no fact. Design it after the
  numbers.
- Once ADR 0030 lands, route the reader's model calls through the sessions layer as a background
  job: its per-purpose model map, concurrency slots and budget. Today reader.js runs `claude -p` itself.
  The runner is injected (deps.runner), so this is a swap of one function.
- CI step for `npm run eval:answer` (replay only), ADR 0023, and contract notes for capsule-pro,
  pwa and mobile.

## Needs from others
- main: OK a fast-model (haiku) extraction pass over every personal-signal user turn (a one-time
  backfill of about $2, then about $0.25/day, configurable), and recording eval fixtures with `claude -p`.
- sessions: the per-purpose model map location and the one-shot background job call. Also
  per-turn memory.answer or a combined memory.context tool (message sent 27 Sep).
- polish-cli: the contract of the low-priority index worker. Until then extraction runs in the
  memory curator's background pass, in bounded batches that yield.
- main/integrator: core/memory/rooms.test.js:227 fails on main's code. agents.create now needs
  presence ("Making or changing an agent needs a person"), and the test does not provide it.

## Changed contracts
- New tools `memory.answer`, `memory.profile`, `memory.remember` (see above); event `memory.remembered`; table `memory_me_told`. New table family `memory_me_*` (memory's own).
