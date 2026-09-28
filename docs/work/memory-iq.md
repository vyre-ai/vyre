# memory-iq

Branch: work/memory-iq · Worktree: ../vyre-memory-iq · ADR 0023 · Owner session: memory-iq

## Scope

28 Sep (the user, via the lead): memory-iq owns recall, the graph and IQ as one product. The old
memory team's branch (work/memory) had one unmerged change, the teach me:you fix, now ported.
Carried forward from its notes: prefers/decided stay off until more gold with distractors; the
Deck's projects view should pass room: slug; agent sessions should put the agent in the caller.

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

## Doing (28 Sep, cutover)
- 7ee03df6 (sync.deleted only from federation's module; sync.* reserved) signed off by the reviewer.
  Federation's module is core/sync: SYNC_OWNERS and RESERVED_EVENTS.sync trimmed to "sync".
- Stream cutover: 0.1.1 batch 1 (target 30 Sep, starts after rc.2 lands). memory-iq's 0.1.1 sha must
  reach the integrator before batch 1 starts; the integrator holds capsule-pro's change until it
  does. Unpair keeps data (d0b916b9); delete is sync.deleted with memory.device as the preview.

## Doing (28 Sep, import, later)
- Built: import.scan (caps, exclusions before listing, credential folders never walked,
  claude_keeps_days), import.plan (pace estimates), import.status, import.progress,
  memory.graph-grew (counts), synced root read per device, sync.revoked forgets everything derived
  incl. fixes (9be6e31a). memory.ask screen input (bb455992), trust world with a trap screen 1.0.
- Waiting: federation's sync.send and the server-side switch record (then import.start/stop/cancel);
  capsule-pro on the screen shape; app-design's 5-stage boards; e2e's code review of import.
- Agreed: launch owns the onboarding step shell and wires the three screens to the tools above.

## Doing (28 Sep, import)
- 0.1.1 flagship, led here: discover, import and build the graph in onboarding. Design:
  docs/design/import.md; ADR 0008 amendment item 5a (one-time import). Next: build import.scan /
  import.plan on the device and import.status / import.progress on the box; owners contacted
  (federation, launch, app-design, e2e).
- rc.2: e2e signed off work/memory-iq-rc2 aaf4fcb5; handed to the integrator.

## Doing (28 Sep, later)
- Sealed IQ 0.62 -> 0.80 (confident-wrong 6 -> 5), open 0.778 -> 0.878, from two failure classes
  found on the open world only (eval-iq --explain): the check refused answers grounded in the
  passage header (034a4397), and retrieval found the question turn with the answer one turn later
  (398f6156, passages carry the reply). Replies re-recorded (both asks files).
- Agent corrections hardened per e2e (e1851941), waiting for re-review. threads.said is the
  switchboard's to build.
- Project graphs (398f6156) and memory.today in the brief (df22ca0c) built.

## Doing (28 Sep)
- Merged main (e79eb5c6). Open-world v2 re-record finished: all 90 replies kept in
  test/eval/asks/open.json (ce980557). v2 open: accuracy 0.778, confident-wrong 1, abstained 0.411,
  ungrounded 0, inconsistent 0. v1 re-recorded the same day on the same golds: 0.767, 2 CW,
  p50/p95 3.8/4.4 s via claude -p, $0.0032 a question. One question apart: not a measured win.
- A/B done. Sealed (blind): v1 0.61 / 9 confident-wrong, v2 0.62 / 6. Open: v1 0.767 / 2, v2 0.778 / 1.
  v2 keeps (already in the RC via 1815b37d). Both worlds' v2 replies committed (test/eval/asks).
- Reader billing fix ec097430 (rc2 branch head; cherry-picked here as well): API keys are left out of model calls unless memory.model.billing is "api".
- Correct IQ in place (95b2b891): memory.correct {answer}, memory.uncorrect {fix}, corrections {answers},
  stats.iq, `vyre memory fix`, eval-iq --fix (open 20/20, sealed 38/38, 0 regressed). Tables
  memory_iq_answers, memory_iq_fixes, memory_me_denied. 0.1.1. Card specs sent to capsule-pro and app-design;
  e2e asked for a review of tailnet corrections and of the sync amendment.
- Session sync: contract agreed with federation, ADR 0008 amended (f63fe0e2), e2e's conditions in
  item 6 (5f36a227). 0.2. e2e reviews federation's transport code when it exists.
- Phone corrections (personWrites, 5f36a227): e2e SIGNED OFF 28 Sep. 0.1.1.
- rc.2 handoff: branch work/memory-iq-rc2 (worktree ../vyre-memory-iq-rc2) = 1815b37d + the teach
  me:you fix ported from work/memory + both asks files + "you prefer" grammar, head 4ff57bb6.
  199/199 memory tests on testbox.
- IQ everywhere: docs/design/iq-everywhere.md (surfaces, ranked gaps, owner specs). Built here:
  memory.ask stream + caller id + memory.thinking/answered (6adfc4b6), `vyre memory ask` on
  memory.ask (6adfc4b6), memory.suggest offered to suggest + suggest.ready (f50c5f21). All 0.1.1
  unless the lead says otherwise.

## Next
- Built 28 Sep: memory.card (e67ba34d), memory.contradictions/settle (fd7f57ab).
- 0.1.1 queue, in order: import.start/stop/cancel
  (after federation's sync.send); then site recipes (memory.recipe per site from glass's
  browse.finished, module browse; self-correcting, person-editable). Landmark shape proposed to
  glass: {role, name, css?, near?}, role+name first, never values. Waits on the lead's review of
  glass's docs/design/agent-browsers.md (work/glass-live b4584a7f) before building.
- Project graphs: recall.search `sessions` filter + retrieve scopes by folders plus picked ids (0.1.1).
- Host-to-server sync: contract in docs/design/iq-everywhere.md; agree it with federation (paused)
  and amend ADR 0008.
- Reader billing: claude -p inherits vyred's env, so an ANTHROPIC_API_KEY there bills API dollars.
  Proposal: strip it from the reader and IQ unless config.memory.model.billing = "api".
- Finish the v2 re-record, report accuracy and cost to the lead, commit asks/open.json, and hand
  the integrator a new RC sha containing 7b48652d.
- Run core/memory/iq/ask.test.js (only when uptime is under 6, nice 15, --test-timeout).
- Record the sealed world's asks without reading them (eval-iq --world sealed --answer --record).
- Phase 4: the second look for people answers, and an answer cache by fact-set version. Phase 5:
  latency on threads.quick; memory.ask in the Capsule, Chat and the phone.
- "Before" for places: its confidence is the current place's, so a wrong past place comes back
  confident (sealed place-history).
- The full backfill cost (about $1.50 to $2.60) waits for the user's yes, via the lead.

## Cheap-wins audit (28 Sep, the lead's ask)

Read the whole pipeline (extraction/reader, curator/derive, graph, memory.ask, retrieve) looking
for hours-not-days wins. Most of the obvious ones (dedup by hash, incremental curation, batching,
a cheap model by default, caching the model's exact reply) are already built — this workstream has
been through a few optimization passes already. Ranked what was left:

1. **Three missing indexes (built, 7c1a9f2e in this doc's head).** `memory_me_model(started)` (the
   reader's `MAX(started)` gap check, on every pump), `memory_iq_suggested(state, thread)`
   ("waiting on you"), `memory_iq_fixes(at)` (`memory.stats`'s `since`). All three were full table
   scans; a person's tables are small today but these are hit on every pump/suggest/stats call, so
   the scan grows with them. No eval-score change (nothing here touches quality) — 230/230 memory
   tests green on testbox, gold/heldout/fresh/sealed worlds unchanged (gold 1/0/0, heldout 1/0/0,
   sealed 0.551, fresh 0.76 — same as before the change).
2. **A circuit breaker on the reader (built).** `once()` schedules itself again only on success or
   a benign wait (busy thread, gap); a real failure (bad JSON, the model call throwing) does not
   reschedule itself, but a NEW personal-signal turn arriving re-triggers `pump()` on the same
   still-queued batch, and each attempt was charged again with no backoff. `drain()` (the
   evaluation, backfill) already retries a bad batch 3 times by design and stays untouched (it
   forces past this, same as the gap and a busy thread). Now: after 3 consecutive failed runs,
   `once()` backs off 5, then 15, then 60 minutes before spending again. New test:
   `reader: repeated failures back off, so a broken model isn't paid for on every turn` (passes).
   This is a tail-risk cost fix (a bad key or a wrong model name left on for a chatty day), not a
   normal-path saving — no eval-score change either.
3. **Checked and rejected: dropping dense/hybrid retrieval for bm25-alone.** eval-iq's ablation
   table looked like a free win on the open world (bm25 alone beats "full" on every metric AND is
   faster: recall 0.931 vs 0.917, mrr 0.763 vs 0.715, p95 0.866 vs 0.848ms). Checked the sealed
   world before touching anything: there hybrid clearly beats bm25 alone (recall 0.763 vs 0.738,
   session 0.888 vs 0.863, answer 0.838 vs 0.813). The open world's win is noise from its own
   distribtion of questions, not a general property. Not building this; recording it here so
   nobody re-discovers the open-world number and ships it.

Other candidates looked at and set aside, cheap in isolation but each needs an eval run to justify
before landing (not "straight away"):
- **The reader's second look (VERIFY) call** runs once per batch unconditionally when there is at
  least one candidate fact. Skipping it for facts already at rule-level confidence (method other
  than "model") would cut a call, but the second look is what catches a wrong "who is who," so this
  needs an accuracy check first, not just a cost one.
- **`passes: 2` by default** doubles every reader batch's cost by design (docs above, "two readings
  keep the union"); halving it would roughly halve reader spend but was already tuned against the
  eval once. Re-cutting it needs an accuracy number, not a guess.

## Needs from others
- main: OK a fast-model (haiku) extraction pass over every personal-signal user turn (a one-time
  backfill of about $2, then about $0.25/day, configurable), and recording eval fixtures with `claude -p`.
- sessions: the per-purpose model map location and the one-shot background job call. Also
  per-turn memory.answer or a combined memory.context tool (message sent 27 Sep).
- polish-cli: the contract of the low-priority index worker. Until then extraction runs in the
  memory curator's background pass, in bounded batches that yield.

## Changed contracts
- core/modules/index.js: a module's ctx.call passes { firstParty } (from the loader) in the callee's meta.
- core/config/index.js: default transcripts add <home>/synced; recall reads each device folder under it. recall.forget (internal). Event recall.embedded. memory listens to sync.revoked and emits memory.forgot. New module core/import (import.scan/plan/status, event import.progress).
- core/harness/index.js harness.brief adds memory.today's lines ("Lately in this project") for a project session.
- recall.search takes `sessions` (union with project_cwds; dropped for any caller but modules and the person's surfaces); dense keep(cwd, session).
- New tools memory.today; memory.retrieve takes `replies`; passages may carry `reply {seq, text}`.
- memory.correct from a model: `from_turn {seq}`, `suggestion`; needs threads.said from the switchboard; events memory.suggested, memory.updated.
- memory.correct takes `answer` (an IQ answer_id) and action `forget`; memory.uncorrect takes `fix`; memory.corrections takes `answers`; memory.stats adds `iq`; memory.ask replies carry `answer_id` and may be `via: "corrected"`; event memory.fixed {id, action, kind}.
- core/suggest/index.js emits `suggest.ready` at the end of start (module.json emits it), so a module that started first offers again. memory.suggest also returns `items` (suggest.offer's shape).
- memory.ask takes `stream` and `id`; events memory.thinking {id, stage} and memory.answered {id, abstained, limited}.
- core/recall/index.js readable(folders, root, env): the person's ~/.claude only for the real ~/.vyre (or VYRE_ALLOW_REAL_TRANSCRIPTS=1). New tool memory.retrieve. Table memory_me_trust. Config memory.personal.skipCwds.
- New tools `memory.answer`, `memory.profile`, `memory.remember` (see above); event `memory.remembered`; table `memory_me_told`. New table family `memory_me_*` (memory's own).
