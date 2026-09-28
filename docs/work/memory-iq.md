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

## Doing (28 Sep, the projects.reach swap)
- Branch work/memory-reach, worktree ../vyre-memory-reach, off federation's work/federation
  (35188a38 projects.reach + 59d6833c caller-as-input-field). Moved core/memory/index.js's own
  reach() and core/files/access.js's own reach() onto ctx.call("projects.reach", { agent, caller,
  kind }) instead of each keeping its own agents.list/projects.list/projects.access.check chain.
  Both were reviewer-cleared on their own; this is the DRY follow-up 59d6833c's commit message
  flagged (files/access.js and memory/index.js not done in that sha).
- memory/index.js's reach() needs one extra bit projects.reach's content-kind reply does not
  carry: whether the resolved agent is literally the assistant (a different privilege tier for
  guard()'s unscoped grace and personalOnly()'s personal facts, neither ever subject to
  projects.access) — the assistant and a wildcard agent read the same shape once every project is
  granted. Answered with a second projects.reach call, kind: "facts" (the one place its reply
  distinguishes them, { all: true } only for the assistant), rather than opening a second door
  onto agents.list for one bit this door does not need to answer.
  files/access.js needed no such thing: it never had an `assistant` field in its own reach()
  shape to begin with (files are raw content either way, no unscoped grace).
- Error codes: both files preserve projects.reach's own thrown code/message verbatim
  (`Object.assign(new Error(r.error.message), { code: r.error.code })`) instead of re-deciding
  denied vs failed locally — one behaviour change worth flagging: files/access.js used to force
  "denied" even when the underlying cause was `agents.list` itself being unreachable
  (`no_such_tool`); it now gets "failed" for that one obscure case, same as memory's reach()
  always did and the same as projects.reach's own thrown error already is. No test exercises it.
- The known snag (59d6833c's own note): core/files/files.test.js and drive.test.js's registry()
  only stood up a fake agents+projects module when a test passed `agents:`, so most existing tests
  had no projects.reach to answer at all — a deny-by-default fallback there would have refused the
  OWNER (a bare "cli"/"deck" caller) in nearly every test, since access.js's reach() now asks
  projects.reach even to decide who the owner is. Fixed with a new shared fixture,
  test/fixtures/fake-reach.js (`reachLogic` the pure decision, `fakeReachCall` for a hand-built
  fake ctx.call, `installFakeReach`/`clearFakeReach` for a real Registry with fake "agents"/
  "projects" modules), always installed now regardless of whether a test cares about agent
  scoping. `access` left out of the fixture entirely (vs. `{}`) simulates projects.access not
  being installed at all (agents.projects' own scope, unchanged, matching both reach()'s own
  documented no_such_tool fallback); `access: {}` or a map simulates it present, deny by default.
  Wired into: core/files/files.test.js, core/files/drive.test.js (Registry harness), and every
  hand-built fake ctx.call that starts the memory module directly — core/memory/access.test.js,
  scope.test.js, personal/answer.test.js, personal/store.test.js (grep for `memory.start(ctx)`
  found all four; no others).
- One real test-visible change, not a bug: core/memory/scope.test.js's "a caller that names no
  agent and no room reads the main graph" test asserted every unnamed non-owner caller's refusal
  contained "main graph" — projects.reach's own owner-vs-not decision now refuses an unnamed,
  unrecognised caller (e.g. "harness", "unknown") immediately with "refused for X", before guard()
  ever gets a say; a bare "mcp" session still counts as the owner there (projects.reach's own
  reachOwnSession) and still reaches guard()'s own, more specific message. Both are refusals
  either way; widened the assertion regex to accept either wording rather than re-deriving the
  old message inside memory/index.js.
- Verified on testbox (load 3-4 at the time): `core/memory/**/*.test.js` + core/files/files.test.js
  + core/files/drive.test.js together, 233/233, `npm run docs:ref` clean, test/docs-*.test.js
  61/61, test/boundaries.test.js 5/5. Locally on the Mac, 3 of files.test.js's agent-scoping tests
  fail on a pre-existing, unrelated macOS quirk (SCRATCH lives under /var/folders, which realpaths
  to /private/var/folders, and describe()'s within() check compares the realpath'd file against
  the fixture's non-realpath'd project.home) — reproduced identically on an untouched
  work/federation checkout, so not a regression; core/memory/module.test.js also hangs locally
  on this Mac on an unmodified work/federation checkout (unrelated, pre-existing, passes on
  testbox), so the local run is not a reliable signal for this repo on this machine.
- Sent shas to reviewer and integrator. Sha: (fill in after commit).

## Doing (SAVED 27 Sep, before a restart)
- RC handed to the integrator: work/memory-iq 1a76d383, the leak fix via e2e's transcriptFolders
  (88c90d56 merged; recall readable() wraps it), source trust, memory.retrieve/ask/suggest,
  recall.search {prefix}, eval-iq and the iq worlds, and ADR 0034 amended (status stable). After
  it: 7b48652d, memory.ask's cap at $0.50/day, with limited plus a message at the cap (the lead
  asked for this in the next RC). Tests at 1a76d383: 319 + 71 pass on testbox. ask.test.js's new
  cap assertions have NOT run yet.
- The open-world memory.ask re-record with prompt v2 (ask.js VERSION 2) was running on testbox
  (the test box's memory-iq copy, `node scripts/eval-iq.js --world open --answer --record`) and was stopped
  for the restart. Rerun that command: it keeps the replies already recorded. Then scp
  test/eval/asks/open.json back and commit it. v1 numbers: accuracy 0.722, confident-wrong 7
  (4 of them over-literal golds, now widened), abstained 0.40, ungrounded 0, inconsistent 0, about
  $0.003 a question.
- Scores (replayed reads): personal 1.0, heldout 1.0, blind 0.959, fresh 0.76, trust 1.0,
  sealed 0.551 with 7 confident wrong (was 0.577 with 6). Two sealed answers were lost because
  Claude's words no longer count. Not tuned on sealed.
- Retrieval (memory.retrieve, real MiniLM): recall@8 open 0.833, sealed 0.638. Graph expansion
  adds 0 on both, but the graph stays (a pillar). Dense weight stays 0.25 (lead). Sealed stays sealed.
- memory.ask runs on sessions' threads.quick (work/sessions db4af9c3, lands after batch 4), else
  `claude -p`. threads.quick sessions write no transcript (sessions c6663f14), and <home>/quick is
  skipped as a second guard.
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

## Doing (28 Sep, chat win #1: "From your past sessions")
- The lead's ask: chat's inline hint when a person starts a message in a project — 1 to 3
  relevant snippets from that project's own past sessions, each with a link and a reason. My
  side is the tool: `recall.related { project_cwds, text, limit? }` -> `{ hits: [{ session, seq,
  ts, name, title, cwd, snippet, score }] }`. Built in core/recall/index.js, right after
  recall.search: owner surfaces only (`callers: OWNERS_ONLY`, no "mcp" at all — chat and
  native-core call it as themselves, never forwarded to a model), and never an unmapped folder
  (project_cwds is checked against projects.list; nothing mapped means an empty hint, not the
  whole corpus). Reuses recall's own `search()` (per_session: 1, limit capped at 3) rather than a
  new ranker — same infra recall.search already runs, already fast.
- Test: core/recall/related.test.js (5 tests: a project's own relevant turns one-per-session,
  an unmapped folder gets nothing, empty text/cwds is a quiet empty hint not an error, never an
  agent even one granted the project, under the 150ms budget on the fixture corpus). First run
  (once the freeze lifted) failed 4/5: the new tool wasn't in core/recall/module.json's
  does.tools list, so it was invisible to the loader ("no tool recall.related"). Added it there;
  5/5 after. Also ran npm run docs:ref (recall.related's description had an em dash, caught by
  docs-check; fixed at the source). 280/280 on testbox (core/recall + core/memory + boundaries),
  19/19 docs-check/docs-index. Sent to the reviewer (a new tool, owner-only, worth a look even
  though it adds no new read path recall.search didn't already have).
- Shape to agree with chat and native-core (message sent 28 Sep): the reason sentence ("you
  fixed this in thread X on Sep 20") is theirs to render from `name`/`ts`/`snippet`, not
  generated here — recall.related returns facts, not prose.

## Doing (28 Sep, security: recall had no project scoping)
- The lead's ask: recall.search ran unrestricted for any caller, including a named agent limited
  to one project — it could search, read (recall.thread) or list (recall.sessions) any other
  project's sessions, since nothing checked who was asking. Built `reach()` in core/recall/index.js,
  mirroring core/memory/index.js's reach()/guard() 1:1 on purpose (same owner set, same
  agents.projects ∩ projects.access intersection, same wildcard-walks-every-project rule, same
  no_such_tool fallback for an install without projects.access yet). New `agent` input on
  recall.search/thread/sessions; a scoped agent's empty project_cwds/cwd defaults to its own
  grants rather than the whole corpus; an out-of-grant ask is refused (a session it can't read
  reads back as "no session", the same message a nonexistent one gets); a paired Mac's answers
  are filtered the same way as a defense against an older, unpatched Mac. Test:
  core/recall/scope.test.js (5 tests: search, thread, sessions, a project taken away narrows
  reach immediately, a mismatched/unknown agent is refused). 273/273 on testbox
  (core/recall + core/memory + boundaries).
- This worktree predates federation's projects.access module (work/federation, d897210d and
  its predecessors) — recall.access.check calls it and gets `no_such_tool`, so reach() falls back
  to agents.projects alone, same as memory's own reach() does on an install without it. Once
  federation's branch lands, extend core/recall/scope.test.js with a projects.access.grant/revoke
  pass (core/memory/floor.test.js's wilma/kit tests are the pattern) to cover the intersection and
  the revoke-narrows-immediately case for real.
- Sent to reviewer (access/trust change).
- **Reviewer signed off, with a MEDIUM and a LOW, both fixed and re-sent:**
  - MEDIUM: `reach()`'s "no agent named" branch returned `all: true` unconditionally, so a
    tailnet guest, a hook, or any caller kind nobody had classified yet read the whole corpus —
    the scoping only ever engaged once an agent was named. Fixed both ways the reviewer offered:
    declared `callers: ["cli","local","deck","capsule","module","mcp"]` on all three tools, and
    narrowed `reach()`'s own fallback to `owner(caller) || ownSession(caller) ||
    ownerDevice(caller)` (kernel utility from core/modules/index.js — covers both the owner's own
    verified device over the tailnet AND a relay-paired device, ADR 0026; the "deck" clause in
    callerAllowed already let both through, but reach() itself first only checked
    `ownerOverTailnet`, missing the paired-device case, a second LOW the reviewer caught on
    re-review), refusing everyone else.
  - LOW (prefix): recall.thread resolved an id/prefix before the grant check, so an
    ambiguous-prefix error told a scoped agent an ungranted session with that prefix exists.
    Prefix resolution (`resolveScoped`, local to the tool) now only considers sessions the caller
    may read.
  - The assistant-vs-wildcard question this raised went round twice before it settled. Recall's
    first cut (b49b98ac) already had the wildcard-agent case (`projects: "*"`, not the assistant)
    walk the per-project path over every project. Federation confirmed the true assistant
    (`kind === "assistant"`) itself is `all: true` in memory, unconditionally. The lead then ruled
    on the actual question underneath it: a personal fact stays unrestricted for the assistant,
    but raw session content does not extend past what is linked — memory narrows its unfiled room
    away from the assistant the same way. Recall returns raw content, so its assistant branch
    walks the per-project path too, over every MAPPED project, unchecked against projects.access
    (being the assistant is what grants it). Landed at that final shape.
  - 2 new tests (guest/hook/unknown-tailnet refusal, extended to also cover a paired device
    working alongside the owner's tailnet device; the prefix-collision LOW), 7 total in
    scope.test.js. 275/275 on testbox (core/recall + core/memory + boundaries). Sent back to
    reviewer.

## Next
- Built 28 Sep: memory.card (e67ba34d), memory.contradictions/settle (fd7f57ab).
- 0.1.1 queue, in order: import.start/stop/cancel
  (after federation's sync.send); then site recipes (memory.recipe per site from glass's
  browse.finished, module browse; self-correcting, person-editable). Landmark shape proposed to
  glass: {role, name, css?, near?}, role+name first, never values. Checked with glass 28 Sep
  (their reply): agent-browsers.md's review has landed and the shape is still good, but the
  browse module itself (browse.task/browse.finished, the reach ladder) is fully unbuilt -- only
  the level-2 plumbing under it (cdpmux.js's per-agent BrowserContext scoping, computerd's
  per-agent identity) has landed, and the browser-kind computer browse.task would run on top of
  is still mid-build (pool.js's schema not settled). Genuinely blocked, not gated on a review
  anymore; glass pings when it's real. Did chat win #1 (recall.related) in the meantime instead
  of idling.
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
- federation: `projects.reach` (core/projects, cohesion's find, 28 Sep) — a single shared reach()
  for memory/recall/files, modeled on recall's own reach() as the reference (nothing wrong found
  there). Once it lands, recall's reach() becomes `ctx.call("projects.reach", { agent, kind:
  "content" })`, mapping its `projects: [{slug, name, folders, threads}]` into the folders list
  already flatMapped here; memory's reach()/personalOnly() split becomes two calls (`kind: "facts"`
  for personal facts, `kind: "content"` for teach/relevant/why/graph), replacing memory's local
  `viaTailnet` with the tool's own `ownerDevice` handling. guard()/scopeQuery()/within() around
  reach()'s return shape stay memory-iq's to keep consistent; pair with cohesion once the tool's
  landed rather than writing the migration blind. Test on testbox, send to the reviewer.
- main: OK a fast-model (haiku) extraction pass over every personal-signal user turn (a one-time
  backfill of about $2, then about $0.25/day, configurable), and recording eval fixtures with `claude -p`.
- sessions: the per-purpose model map location and the one-shot background job call. Also
  per-turn memory.answer or a combined memory.context tool (message sent 27 Sep).
- polish-cli: the contract of the low-priority index worker. Until then extraction runs in the
  memory curator's background pass, in bounded batches that yield.

## Changed contracts
- core/recall/index.js: recall.search/thread/sessions take `agent` (a caller-named agent, checked
  against the caller string's own `agent:<name>` the way memory's reach() does). A named agent's
  reads are scoped by agents.projects ∩ projects.access; empty project_cwds/cwd default to its
  own granted folders rather than the whole corpus; a session or folder outside its grant is
  refused (a scoped-out session reads back exactly like a nonexistent one). recall.sessions'
  `ids` and a paired Mac's answers are filtered by the same grant. All three now declare
  `callers: ["cli","local","deck","capsule","module","mcp"]`. The assistant and a wildcard
  (`projects: "*"`) agent both walk the per-project path over every MAPPED project (never
  `all: true`, never an unmapped folder's raw content — the lead's ruling on recall vs. memory's
  personal facts); the assistant unchecked against projects.access, a wildcard agent intersected
  with it.
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
- New tool `recall.related { project_cwds, text, limit? }` -> `{ hits: [...] }` (chat's "From your
  past sessions" hint). `callers: OWNERS_ONLY` (no "mcp": never an agent). No new tables, no new
  events.
