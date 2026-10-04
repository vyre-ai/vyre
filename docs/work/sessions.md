# sessions

Branch: work/sessions · Worktree: ../vyre-sessions · ADR 0030 (Vyre-owned sessions and the provider router)

## Scope
ADR 0030. User said GO (27 Sep): the Agent SDK becomes the default for every session Vyre starts.
Steps 1 to 3 behind `sessions.driver`; flip the default as soon as the full suite is green on it;
then retire the CLI runner. Approved defaults: auth box setup-token / Mac login / api-key
fallback; bundled Claude Code on the box, installed on the Mac; idle 10 min; cap 6 on the box;
Capsule quick asks to the box assistant, Mac project folders Mac-owned.

## Done
- ADR 0030, proof, steps 1 to 3, security blockers, models, providers, adoption, fork, rewind,
  steering and the queue, cost fix (see CHANGELOG, commits up to b8b1a0a7).
- API key on fd 3 (measured leak via Bash env; OAuth token already scrubbed by Claude Code) 72b6a78d.
- Full suite on the SDK driver: 2551 tests, 2499 pass; failures were stale docs, a test writing in
  VYRE_HOME, journey DB-lock flakes (pass on rerun). Default flipped to sdk: d12171cc (batch 3a).
- After 3a: idempotent sends (keyUuid), threads.queue, mode on record (359764d7); concurrency
  slots (a4118f6c, 527cc480); context in thread.usage + threads.post (468af69f); threads.model,
  threads.commands, rewind restore code (7543952e); images, threads.shell, threads.remember,
  thinking, background tasks (034c71e5).

- After LOGOUT 4: Capsule quick answer = Vyre IQ prompt (core/sessions/iq-prompt.js, capsule@1,
  replace mode, facts numbered, thinking off, version on thread.started), eval
  scripts/eval-iq-prompt.js --live + test/eval/iq-prompt.test.js. No temperature knob exists in
  Claude Code or the SDK (reported to the lead).
- Event names stay as chat's contract reads them (model.switched, thinking.switched,
  thread.thinking); sessions.models added.

- Option A wired: per-thread socket (Switchboard.openSocket/closeSocket), VYRE_SOCKET in the
  child env, client.js honours it, MCP server + ensureUp never start a vyred inside a session,
  spawner default on for a box, sessions.thread_socket auto|on|off.

- "Doesn't ask": threads.mode bypassPermissions (person-only, no Touch ID), sessions.mode.set
  project default, plugin required, in-process floor on the SDK, answers never grant it.
- cohesion catches: Bash ask summary redacted; asks rows keep project.

- Effort (threads.start/launch effort, threads.effort, effort.switched), threads.send
  {model, effort} for Cmd-Return; queued images kept; steers persisted (threads_steers) and
  restored on resume.

- threads.quick (warm lean sessions per purpose) for memory-iq; usage pause per auth
  (sessions.usage.*, usage_paused on sessions.slots take with auth).

## Doing
- 0.2 build, wave A0/A on branch work/sessions-02 (pushed; land only through the integrator onto
  stage/0.2 after reviewer-2). Done so far, in order:
  1. 845ae5dc caller identity: vyred's route() reads the verified agent's stored grant from the new
     internal `agents.scope` and puts `meta.granted` ("*" or slugs) and `meta.agentKind` on every
     call. iq's memory.facts/ask/recall.search must read meta.granted, not input.project_cwds
     (harness/mcp/server.js scoped() is still client-side; iq's to change). Test: "carry the grant".
  2. be926527 spawner: spawn request `account` (uid 2000-2063) and `shared`; HOME /home/acct/<uid>
     checked (dir, not symlink, owner uid, no group/other bits) at request and at start; gid = uid, no
     groups unless shared; `wipe` op. Env: VYRE_ACCOUNT_UID_MIN/MAX, VYRE_ACCOUNTS_HOME.
  3. 1bad084f, cbc79cee accounts: sessions_accounts (kind api-key|setup-token|login, uid allocation,
     dirty-uid wipe before reuse), scope-checked resolve (H1), `account` kept on threads_runs and in
     KEPT opts, credential from the vault as the provider's env var (threads manifest needs.vault
     "per-account"), removed account on resume -> code account_removed (M3).
  4. 97e18c8a, 8d60b974 generic ACP driver (hand-rolled ndjson, not the SDK), fake ACP agent,
     conform() safety set, Grok and Codex entries registered by core/sessions (does.providers),
     floor passed to non-Claude drivers, harness MCP server passed in session/new mcpServers,
     agent session ids persisted (sessions_acp).
- Known gaps, honest: (a) Claude accounts on a box run as the account uid, so vyred cannot read
  their transcripts under /home/acct/<uid> (0700): needs a decision (group-readable projects dir or
  a transcript relay) before Claude accounts are used on a box. (b) Grok/Codex flags and login
  locations are UNVERIFIED until a real account runs on a hosted runner (needs a pay-per-use test
  key from the lead). (c) 11 Mac-only failures in core/sessions tests (/proc pid, subreaper, socket
  peer) predate this work; Linux CI is the judge. (d) sessions.accounts.signin (device-code flow)
  not built; login accounts need it. (e) The handoff brief's older half is a plain cut, not iq's summary yet; an agent thread's own auth (agents auth.vault) is dropped on a switch, so a switch needs an account.
  5. 0f58e2ce threads.switch (between turns, brief, thread.provider event, notice) and
     sessions.routes.get/set/next with switchboard routeFallback on a limit; same-provider lists need
     acknowledge:true; an agent sets only its own list or a granted project (uses meta.granted).
  6. Review round (to 0.2 head): uid allocation lock + unique index; provider keys via spawner env (fd 3 cannot serve env-reading CLIs; runner spike must check tool subprocesses); wipe kills uid procs and clears /tmp, TMPDIR in HOME; ACP fs O_NOFOLLOW + fd check; bypass start mode pinned or refuse; accounts add/remove/bind no longer person-only; signed_in from vault; threads.quick {stream} via ctx.call onPartial; account HOME 710 gid=uid with vyred in every account group, transcript glob per account, real-uid isolation test (accounts-isolation workflow, green on a hosted runner); codex custom endpoint flags for the OpenRouter proof.
  7. eed82569 asked reach enforced in code + threads.origin for recall. Then: sessions.accounts.signin (core/sessions/signin.js: runs codex login --device-auth / grok login --device-code / claude auth login as the account, returns url+code, paste-back for claude; all three commands UNVERIFIED until a runner proof) and the OpenRouter API-key driver (drivers/openrouter.js, process:false tools:false, conform adjusted; registered as provider openrouter; VYRE_OPENROUTER_URL overrides the endpoint for tests). Socket-based agent tests (grant, asked) flake on the Mac with 'caller is not in it' (process-table race), pass on quiet runs.
  Next (old list, signin and OpenRouter now done): sessions.accounts.signin (device code per provider), OpenRouter driver, rooms deferred to 0.2.x, real-account proofs on a runner once keys exist, review fixes.

- 0.1.1 test-fix queue from team-lead (branch work/sessions-011 off stage/0.1.1 d9b916d4, both
  failures predate today, also seen on 029756bc): fixed.
  1. `apps/app/src/session/model.test.js` "idle is not ended": `deck/chat/core/session-state.js`
     already speaks the canonical vocabulary (lib/thread-status.js: a `thread.stopped` reason
     idle/restart/rewind guesses "paused", not "idle" - matches deck/chat/session.js's own
     `idleClosed`). The app's own `apps/app/src/session/model.ts` had drifted: `stateOf()` was a
     hand-rolled, WRONG mirror of raw record status (starting/working/waiting/idle/stopped, apps/
     CONTRACT.md 3.2) - raw "waiting" (an ask open) passed through as "waiting" instead of
     "asking", raw "idle" fell to a default of "idle" instead of "waiting", and "working" mapped
     to the non-canonical "running". `stateWords()`/`busy()` matched that same stale "idle"/
     "running" vocabulary. Rewrote `stateOf()` to mirror `threadStatus()` by hand (this file is
     pure, no runtime imports, so it can't just import lib/thread-status.js), and `stateWords()`/
     `busy()` to use "paused"/"working"/"asking" like deck/chat/session.js's BUSY set does. Test
     file updated to match (it was internally self-consistent with the old wrong vocabulary, so it
     never caught the drift). 9/9 model.test.js, 23/23 with pwa+vault+thread-status, testbox.
  2. `core/cli/commands/home.test.js` "inside a project folder..." and "New session in a
     project...": not the switchboard/where() worktree hook (ADR 0041) - `registry.call(tool,
     input, caller)` defaults `caller` to "unknown" when omitted (core/modules/index.js:590), and
     these two tests called `registry.call("projects.create", {...})` with no third argument.
     projects.create's callers list (OWNER + "module") denied "unknown" outright, so the project
     was never created; the screen then had no project to preselect/expand, the cursor landed on
     "New session without a project", and the resume/new-in flow never fired. Added the missing
     `"cli"` caller argument (matches the working pattern already used elsewhere in this same file,
     and in core/projects/projects.test.js:323). 7/7 home.test.js, testbox.
  Full sweep of apps/app/session+pwa, deck/vault, lib/thread-status, core/cli/commands, core/cli/
  screen and deck/chat: 680/680 on a second clean run (one flake on the first pass under load
  13.6, per RULES.md's "wait if load is over 12" - not our two files, did not reproduce).
- Reviewer SIGNED OFF the whole planner-task range as one: b786a799 + db916908 + dfc402e9 +
  7483788d. Open LOW for later (not blocking, not done): a missed firing after downtime runs its
  task immediately on catch-up; reviewer's suggestion is to hold a stale one for the person instead
  of just running it. Noted here for whoever picks up planner next (could be me).
- Resume 10 continued: the escalation MEDIUM reviewer held dfc402e9 on (team-lead: a task must
  never ring/escalate like an alarm) fixed at 7483788d - fireItem gives a task's firing next_ring:
  null unconditionally, and fired() only ever runs a task on ring 1 as a second guard. New test:
  default settings, advance past escalate_after x escalate_max, run_count stays 1 (was 4 before
  the fix). 26/26 planner.test.js, 31/31 with boundaries, testbox. This closes b786a799 + db916908
  + dfc402e9 as one range, per the reviewer.
- Resume 10 continued further: cb387d88's LOW + nit fixed (ac37089b) - safeRequest() checks
  request against /^[\w-]{1,64}$/ before it is ever stored or emitted (threads.post's tool
  boundary); fixed a comment overclaiming word-boundary truncation on APPEND_TOTAL_MAX (it's a
  plain slice(), a safety bound not a rendered cut). docs/design/projects-map.md (mine, owner:
  sessions) failed docs-check - added to nav.json under Contributing, dropped every em dash, and
  de-backticked memory.today/vault.uses (neither is a real tool in this tree - grepped memory-iq
  and vault to confirm; didn't touch the Built/Gap claims themselves, that's their call) (40379d4a).
  test/docs-*.test.js 61/61 on testbox.
- Resume 10 continued: reviewer verdicts on both sent shas, addressed.
  - Reviewer HELD b786a799 (planner task kind) on 2 HIGHs: a task from a bare mcp/module/thread-
    scoped caller launched AMBIENT with the person's own scope at fire (no real agent claim
    matched); a task could post into ANY thread the creator named, as module:planner, a confused
    deputy. Fixed at dfc402e9: taskScope requires a genuinely claimed agent identity (or the
    person) to add or redirect a task at all; a non-person's task may only target its own calling
    thread (meta.thread now threaded through the tool() wrapper AND the paired-Mac `as` forward
    path); a project-only task needs that project inside the creator agent's own agents.list
    scope, checked again at add, at update, and right before it fires (MEDIUM). 25/25
    planner.test.js (5 new), 106/106 with goals+harness+switchboard+boundaries, testbox.
  - Reviewer's LOW 2 on goals ccf2e0f1 (SIGNED OFF, not blocking): naming both a thread and a
    project on inScope checked only the thread. Fixed at 9c6ec941: both must hold when both are
    named. 8/8 goals.test.js (1 new).
  - Reviewer's LOW 1 (swap goals' isPerson for cohesion's lib/caller.js, 87149563) NOT done: that
    lib needs core/presence's PERSON_SURFACES/personOnly, which this branch does not have yet (it
    predates the personguard hotfix b3b7b1dc/002e6577 cohesion's tree already carries). Cherry-
    picking someone else's in-flight security work to close a LOW is the integrator's job at the
    stage/0.1.1 fold, not mine to force now - told cohesion and the reviewer directly.
- Resume 10 (2026-09-28), the four-item queue, all four done:
  1. Reviewer's HOLD on goals bb3b9b4e was already fixed locally, uncommitted, as ccf2e0f1
     (person = owner surfaces + owner devices, not "no agent name"; callers declared on all five
     tools; goals.get/list scoped like milestone-done; goals.set checks the TARGET scope too).
     Sent to the reviewer for a fresh look (it predates this resume; the reviewer's notes still
     show it HELD).
  2. The three harness.brief patches, one sha (cb387d88): APPEND_TOTAL_MAX 2000 on the joined
     style+team nudge (ellipsis, not an em dash, truncated at the one join point); a `request` id
     threaded through threads.post -> Switchboard#post/queue -> thread.sent/thread.queued ->
     threads_inbox (new column) -> threads.queue's read-back; style.append gets {project} only
     when harness.brief's own inScope() says this agent is in scope (else {}, the account-level
     voice only) - closes the reviewer's LOW on 36caa4ad.
  3. The waits_on re-fire bug (db916908): a chained task's own state never changes when it runs
     (by design, for a recurring chain), so matching "dependency done AND task still open" fired
     again on a reopen-and-redo of the same dependency. Fixed with `waits_on_fired`, the
     dependency's own done_at at the last run - done_at is fresh per completion and never reused
     across a reopen, so it distinguishes "the same one, already handled" from "a genuinely later
     one" without touching the task's state.
  4. b786a799 (planner task kind + waits_on) sent to the reviewer per the lead's queue (it went to
     reviewer-2 originally as a mechanical extension; the lead wants the security read too).
  docs/reference regenerated (ea30b29a) for both the goals callers and the harness/threads
  description changes. All tests run on testbox (not the Mac): planner 22/22, goals+harness+
  switchboard+boundaries 102/102, both sessions-turns files 43/43 (39 sdk skipped, no SDK
  installed there), test/docs-*.test.js 60/61 (the one fail, docs/design/projects-map.md missing
  from nav + em dashes, predates this session and isn't sessions' file - not fixed here).
- Resume 9 check (2026-09-28): confirmed a session started with no project can be attached to
  one later. `projects.add-threads` (CLI `vyre pick <project> <thread>...`) already does this;
  `test/projects-cli.test.js` test 22 ("vyre start opens a new named thread ... pick and unpick
  change the marker") exercises exactly this against a real `vyre`/vyred with a fake `claude`.
  Reran on testbox: 23/23 (`test/projects-cli.test.js` + `core/projects/projects.test.js`).
- Lead flagged the residual: picking a session seconds after it starts (exactly when a person
  says "put this in project X") could fail if it isn't in Recall's catalogue yet. Turned out
  `Projects.addThreads` never looked at the catalogue at all; it just writes the marker off
  whatever id it's given. The real gap was the CLI's `findThread`, whose non-numeric path only
  matched rows already in `projects.catalog`. Fixed at edf8c0bc: `findThread` now recognises the
  shape of a Claude Code session id (UUID, optional `/agent-...` suffix) and passes it through
  literally when no catalogue row matches, instead of refusing. New test in
  `test/projects-cli.test.js` ("vyre pick takes a live thread id straight away, before Recall has
  indexed it"); also checks a near-miss string is still refused. 24/24 on testbox
  (`test/projects-cli.test.js` + `core/projects/projects.test.js`), boundaries 5/5.
- Asked chat whether the Deck/phone already have an "Add to project" action for a project-less
  live session (tap the project chip); if not, chat builds it on `projects.add-threads`, which
  now works pre-index too.

- Task 1, first fix: shipped `thread.status`, the canonical session-state vocabulary cohesion
  flagged (three names for one state inside switchboard's own blast radius: internal "waiting"
  means an ask is open, internal "idle" means ready-for-input, and the STATE map/CLI separately
  relabel "working" to "running"). New pure lib `lib/thread-status.js`; switchboard emits
  `thread.status` alongside the unchanged legacy `thread.state`; `threads.get`/`threads.list`
  gain `canonical_status`. Also covers "failed" (its own emitRaw, was not in the old STATE map
  at all) and "finished" (a clean stop, derived from stopped_reason). Tests: new
  lib/thread-status.test.js, two assertions added to existing sessions.test.js turns (the ask
  sequence and the failed-turn sequence), chat-sessions-contract still green (thread.status was
  already listed there as a future event chat listens ahead of). Testbox: 98 pass / 0 fail
  (switchboard + sessions + boundaries + lib), docs:ref regenerated, docs-*.test.js 60/61 (the one
  failure, docs/design/projects-map.md nav/em-dash/stale-mention debt, predates this change - not
  touched here, not caused by it). Sent to reviewer-2 (no auth/spawn/permissions surface
  touched). queued (core/sessions/slots.js, pre-thread) deliberately not folded in; documented in
  the lib.
- Follow-up at 86d3e1a2: added `LIVE_STATUSES` to lib/thread-status.js (the raw internal
  liveness set switchboard's own `LIVE` const now derives from too), for cohesion/native-core's
  harness glue sha (core/harness's subagent-slot gate currently repeats the four raw strings as
  a literal). 57/57 on testbox (switchboard + boundaries + lib).
- 8th canonical state, "paused" (lead's call): stopped_reason idle/restart/rewind end the
  process but nothing is wrong (threads.send resumes them) - split out from plain "stopped"
  (the person pressed Stop) and from "failed" (a nonzero exit code or a signal, a real crash).
  A person must never see the idle-close-shown-as-an-error need (Needs from others, below) as
  the same bucket as a crash, or vice versa. lib/thread-status.js updated + its tests split into
  one per bucket; sessions.test.js gained real e2e assertions on the idle-close test ("paused")
  and the threads.stop test ("stopped", not "paused"). Testbox: 109/109 (switchboard + sessions +
  boundaries + chat-sessions-contract). Told chat and cohesion the 8th state; sent to reviewer-2.
- Task 1 fix #2 (crash recovery, picked from Needs above without waiting for chat/native-core's
  numbers): `recover()` (runs once at vyred startup, marks every thread that looked LIVE before
  the restart as stopped/reason "restart", closes its open asks as cancelled) only ever emitted
  `thread.stopped` - never the legacy `thread.state` or the new `thread.status`. A surface told
  to read `canonical_status`/`thread.status` instead of `stopped_reason` by hand (the note I just
  added above) would see nothing in real time on a restart: right, but silent, until its next
  poll of `threads.get`. Fixed: `recover()` now also `emitRaw`s `thread.status {status: "paused"}`
  (via the same `threadStatus()`) and updates the in-memory `this.states` bookkeeping, so a live
  listener sees "paused" the moment the box comes back, not a gap. Extended the existing
  restart test ("switchboard: vyred restarting marks its threads stopped") with both the live
  event and the at-rest `canonical_status`. Testbox: 109/109 (switchboard + sessions + boundaries
  + chat-sessions-contract).
- reviewer-2's finding on 6e2f8a71 fixed at 854a7752: `threadStatus()`'s fallback
  `THREAD_STATUSES.includes(raw) ? raw : raw` returned `raw` either way - dead code, and a
  latent trap for a future raw status added without updating this mapping. Now fails safe to
  "stopped". New test.
- Task 1 fix #3 (native-core's measured/concrete finding #2, not a number but a real correctness
  trap): threads.fork/threads.start/threads.launch all resolved through `launch()`, which
  returned bare `record(id)` - `.id` only. threads.rewind separately built its own answer and
  happened to echo the id as `.thread` too. Fixed at d16a345f: `launch()`'s two return points go
  through a new `launched(id)` helper (`{...record(id), thread: id}`); rewind's three return
  points gain `.id` alongside its existing `.thread`. `.id` canonical, `.thread` a deliberate
  alias kept for one release. Real e2e assertions added on threads.start, threads.fork,
  threads.launch (the job/agent path) and threads.rewind, not just a unit test; the one exact-
  shape regex this touched (chat-sessions-contract's literal-source check on rewind's answer)
  updated to match. Testbox: 110/110.
- Task 1 fix #4, resume reliability (measured, per the lead): time to first token against the
  fake claude (isolates Vyre's own spawn/resume overhead from real model latency) - after an
  idle close ~200-300ms, after a restart ~190-250ms, after a real crash (SIGKILL) ~205-260ms.
  All fast; added as loose 5s regression guards on the existing idle-close test
  (sessions.test.js) and the restart test (switchboard.test.js), plus a new permanent crash test
  (sessions.test.js: SIGKILL is said as thread.status "failed", never "paused", and the next
  message still resumes it). f64dab91.
- While measuring under load, found a real reproducible bug, unrelated to anything else in this
  session but caught by the same exercise: `sessionsConfig()` defaults to the SDK driver and
  reads `VYRE_SESSIONS_SDK_DIR` straight from the environment, so a shell that still has it set
  from testing the SDK driver (this file's own recommended way to do that) silently flips
  `switchboard.test.js` onto the SDK driver too - that file has no driver-loop/skip logic (unlike
  sessions.test.js) and speaks the CLI runner's own protocol to the fake, so 5 ask-handling tests
  failed in a way that looked exactly like load-induced flakiness. Verified it predates this
  session (reproduces on d65353a8 too). Fixed at 476437fc: `boot()` pins `VYRE_SESSIONS_DRIVER`
  to "cli", saved/restored like its other env vars. 47/47 with the var set (was 42/47); full
  suite 147/149 (2 skipped, 0 failed) with the real SDK also installed on testbox.
- rc.2, release-critical (lead): two of the full-suite-at-concurrency-4 failures
  (/tmp/rc2-full5.log on testbox) were core/sessions/sessions.test.js's own - an ENOTEMPTY on
  rmSync, and the whole file blowing its 90s timeout. Root cause: tempHome(t)'s cleanup (stop
  the daemon, then rmSync) is registered first inside boot(), so it always runs before start()
  is even called - node:test after-hooks run in registration order (verified empirically). It
  already knew to stop a *spawned* vyred (stopDaemon() reads vyred.pid) but explicitly skipped
  an in-process one, leaving that to boot()'s own separate `t.after(() => d.stop())` - registered
  second, so it always ran too late: the directory got removed while the daemon (and any live
  child) was still writing into it. Fixed at 362923e3: `tempHome()` takes an optional `stop`
  callback and runs it first, in the one place guaranteed to go first; `boot()` passes a closure
  over a `daemon` variable set once `start()` resolves, dropping its own too-late hook. Found the
  identical latent bug in switchboard.test.js's boot() (not in the rc.2 log, but the same shape)
  and fixed it the same way at f454a757, adding a `setDaemon()` for the restart test's second
  daemon. Verified at `--test-concurrency=4 --test-timeout=90000` on testbox, both files, both
  driver configs, repeated runs: 0 fail (was failing before). Sent to reviewer-2 and the
  integrator for pre/rc.
- Checked whether an env-var leak (like the VYRE_SESSIONS_SDK_DIR one above) could explain e2e's
  "vydred cannot read which processes this call runs under" failures: no. That message comes
  from `core/daemon/peer.js`'s `ancestry()`/`insideClaude()` (via `core/daemon/index.js:235`)
  failing to read a `/proc` entry to the top of a caller's process chain - a live-process-table
  read race under load, nothing to do with which env vars or driver are set. Told e2e directly
  with the exact code path.
- Queue item 2, teammates section 1 (docs/design/teammates.md, work/teammates 686e08e7 built
  core/team's side): `harness.brief` now calls `team.project-append({project})` once the slug is
  known and in scope, and prepends its `text` (when not null) ahead of the project's own brief.
  Null-safe through the same `ask()` every other cross-module call in this hook uses - no
  core/team, or team.default off, changes nothing. Checked core/team/index.js directly: team.ask
  has no `callers` restriction at all, so "give the session the team.* tools" needed no change on
  my side - already true. e868f5e2. Tests: harness.test.js's projects+memory test extended with a
  fake team module (checks ordering), plus a new test for both null-safe paths. 13/13 on
  core/harness, 20/20 with test/harness.test.js + boundaries.
- rc.2 follow-up (lead's call, not raising the timeout): split `core/sessions/sessions.test.js`
  into two files - `sessions.test.js` (pure/config tests + the first 17 driver-parametrized
  ones) and the new `sessions-turns.test.js` (the other 18) - sharing `boot()`/`until()`/
  `terminalSession()` from a new non-test module, `core/sessions/testing/boot.js` (excluded from
  the boundaries scan like every other `testing/` folder; unchanged logic, moved verbatim).
  `d2a0207c`. Verified at rc.2's exact conditions on testbox: both new files together with
  switchboard.test.js, boundaries, chat-sessions-contract, thread-status and harness - 175/177
  pass, 2 skip, 0 fail, 54-55s twice in a row, versus 87.5s for the one file alone before.
- teammates' second small pickup, bundled with the first: `style.append` (ADR 0037, core/style's
  side already built) alongside `team.project-append` in `harness.brief`. Unlike team's, it's not
  project-scoped ("the house voice for every session") - applies even outside a project and to an
  agent out of scope. Order: house voice, then team nudge, then project brief, then lessons.
  `36caa4ad`. 28/28 on core/harness + test/harness.test.js.
- Goals+/later, approved design (team-lead): core/goals own module, planner kind "task" +
  waits_on, 4 rules (creator-scope, recurring visibility+pause, milestone-done scoped, person
  accepts a goal). Built so far:
  - `7e88b74e`: core/push's side first (purely declarative - NOTES's event-type map wires up any
    listener with no new registration code). New `goal` kind (kinds.goal, default on), routes
    `goal.milestone`/`goal.done`. 8/8 on core/push.
  - `bb3b9b4e`: new module `core/goals` (roles box, local) - `goals.set` (a person's own call is
    active at once; an agent's is a proposal, state `pending`, rule 4), `goals.accept`
    (PERSON_ONLY, added to core/presence), `goals.milestone-done` (rule 3: scoped to the goal's
    own thread or project, checked via `threads.get` for an agent's calling thread; a person may
    always tick one; re-ticking an already-done one is a no-op not a second event; the last one
    marks the goal done and emits `goal.done`), `goals.get`/`goals.list`. Self-contained, no
    cross-feature imports. 4/4 new tests, 30/30 with push + harness + boundaries.
  - `b786a799`: planner kind `task` + `waits_on` (rules 1 and 2 - /later's actual firing
    mechanism). Reuses every existing time path unchanged (resolveTime, the scheduler) for
    one-off/relative/recurring; a task with a `thread` fires via `threads.post` (the thread's own
    scope governs it); with none, `threads.launch` with `agent: <name>` parsed from the item's
    own `source` column (`"agent:<name>"`, already how core/planner tags an agent's item) - rule
    1, never more than that agent's own scope; a person's own task passes no agent, ambient.
    `waits_on` chains a task after another item's `done`, via a `planner.changed` listener,
    entirely outside the scheduler. `run_count`/`last_result` on every fire (rule 2, a runaway
    loop must be visible); `paused` stops one task without losing its history. Caught and fixed
    two real bugs before shipping: `waits_on`/`paused` were accepted by the schema but silently
    dropped at insert (missing from the row literal), and `planner.update` had no handling for
    either despite `EDITABLE` listing them (`EDITABLE` itself turns out unused elsewhere - dead).
    21/21 on planner.test.js, 55/55 with the rest of core/planner + boundaries.
  Sent core/goals to the reviewer (real scoping/security logic); push routing and the planner
  task kind to reviewer-2 (mechanical extensions of existing, already-reviewed patterns).
- SAVED for restart (2026-09-27). Handed off: e8fd0e42 to the integrator (release candidate; 501ca3fc e2e-passed on db4af9c3); e9d734c7 (work/sessions-sdkfix) = sdk-driver test fix alone for batch 4. Waiting on: native-core settings.resolve sha, cohesion context.now, vault f4272358 on main (threads needs.credentials) and vault's Connect Claude relay to review, native-core c012c13c aliases.
- X-Vyre-Call-Id from the MCP server; quick sessions ephemeral; stopAll waits for spares: tested, pushed.
- Now own onboard's Claude sign-in (onboard.claude, setup-token.js): review vault's vault.connect relay when it arrives; add threads needs.credentials (vault f4272358 shape) once on main.
- Lead's list done through 7. Compile phase next: the promised items below, then docs + polish.

## Next
- When native-core c012c13c (MODEL_ALIASES) lands: keep it on merge; make sessions.models read it, or retire sessions.models for sessions.models.get aliases.
- Tell launch (onboard page restyle) if vault's Connect Claude relay changes any onboard page text or step.
- After 0.1.0 (the lead): the 5 cross-imports among core/sessions, core/switchboard,
  core/transcripts, core/spawner and core/harness (frozen in test/boundaries allowlist) are mine to
  remove: merge sessions and switchboard into one module, or talk over ctx.call.
- vault: threads record origin (the Capsule) for vault's surface mapping; Claude sign-in as a
  vault need (needs.credentials on threads, onboard.claude callable by module:vault).
- Promised (after the queue): settings.resolve at start (effort, mode, max_turns, budget_usd,
  checkpoints, fast); server `t` on thread.text; threads.effort + settings.changed level
  session (ADR 0035); thread.status event; context.now in enrich/capsule; brief adds planner
  agenda, needs, connections (cohesion); tool_use id on call meta once kernel has the field.
Then the compile phase: tests for every piece, docs, polish.
Testing the SDK driver on testbox: VYRE_SESSIONS_SDK_DIR=~/vyre-ci/sessions-sdk (0.3.283, with
optional deps; without them the tests silently run on the CLI).

## Doing (github, ADR 0041)
- github asked for gitWithAskpass in lib/git-safe.js and a session start/cleanup hook for their
  worktree feature. lib/git-safe.js does not exist on this branch (merge-base a3a844e4, 196 commits
  behind main; git-safe.js landed after that) and a clean isolated cherry-pick isn't possible either
  (e5944433 depends on vault's later kinds.js/defaultField refactor, also not here). Told them: add
  it fresh as a new file, self-contained, and the integrator reconciles at the stage/0.1.1 fold; a
  full main merge is too large to do safely mid-session (196 commits, real overlap in switchboard/
  harness/planner - files I've been actively editing for reviewer holds this session).
  Also corrected their hook design against real names: `thread.started` exists; there is no
  "archived" thread event or a project-change event at all (projects.add-threads/remove-threads
  emit nothing today) - waiting to hear which real status (finished/stopped/paused) they actually
  want cleanup on, and whether the missing project-change event is a real blocker for them (I'd add
  it if so). Sent, not blocking either side.

## Needs from others
- integrator: one full-suite run with `VYRE_SESSIONS_DRIVER=sdk VYRE_SESSIONS_SDK_DIR=<dir with SDK 0.3.283>`.
- box: pre-install the SDK with its bundled binary in the image (`npm i --omit=dev
  @anthropic-ai/claude-agent-sdk@0.3.283` into <VYRE_HOME>/sessions-sdk, or set
  `sessions.dir`), so the first session on a fresh box does not wait on a 255 MB download.
- existing boxes: the vault's claude-setup-token and anthropic-api-key must be granted to module
  `threads` (`vyre vault grant claude-setup-token threads`); new onboarding does it.
- chat, capsule-pro, mobile: the idle-close-shown-as-an-error need is met server-side now -
  `thread.status`/`canonical_status` say "paused" for an idle close, a restart or a rewind, never
  "stopped" or "failed" - read that instead of `stopped_reason` by hand; `threads.interrupt`;
  `busy` refusal on start; sessions.prompt.* for a settings screen.

## Changed contracts
- core/transcripts (chat, 9fd902ac, while you were paused - cohesion item 18): `blocks()` /
  `recall.transcript` add `images: [{media_type, data}]` alongside a user or tool block's existing
  text, for a person's own pasted picture and a tool's own (a screenshot, a Canva render). Only
  png/jpeg/gif/webp; caps: 2 MB per image, 4 pictures per block, 6 MB per block total (the total
  can bind before the count does); over any cap, no `images` field, same "[image]" text as before.
  New consts IMAGE_MEDIA_TYPES / IMAGE_BYTES_CAP / IMAGES_PER_BLOCK / IMAGES_BYTES_CAP and
  `imagesFrom()` in core/transcripts/index.js. Sent to reviewer as its own sha (data served to
  surfaces). Worth folding into whatever shape you and chat land on together once you're back.
- `test/helpers.js`'s `tempHome(t, { stop } = {})` takes an optional `stop` callback, run before
  its own daemon-stop/rmSync cleanup - for a test that runs vyred in-process (`start()`) rather
  than as a spawned `vyre up`, which `stopDaemon()` has no way to reach on its own.
- New event `thread.status` {status: one of THREAD_STATUSES, ...turn}, emitted alongside the
  unchanged legacy `thread.state` at every status change (module.json's watches.emits gains it).
  `threads.get`/`threads.list` records gain `canonical_status`; the existing raw `status` field
  is unchanged. New pure lib `lib/thread-status.js` (`THREAD_STATUSES` - starting, working,
  asking, waiting, paused, stopped, finished, failed; `threadStatus`, fails safe to "stopped" on
  an unknown raw status; `LIVE_STATUSES`, the raw internal liveness set).
- `threads.start`, `threads.fork`, `threads.launch` answers gain `.thread` (an alias of `.id`,
  kept for one release); `threads.rewind`'s answer gains `.id` (an alias of its existing
  `.thread`). New `Switchboard.launched(id)` helper backs the first three.
- CLI `vyre pick <project> <thread>` (and `unpick`): a `<thread>` shaped like a Claude Code
  session id (UUID, optional `/agent-...` suffix) is now accepted even when Recall's catalogue
  has no row for it yet, instead of erroring "no thread matches". `projects.add-threads` itself
  is unchanged (it never depended on the catalogue).
- threads: send {mode}, unqueue, edit, send-now, fork, mode, interrupt; events thread.turn, state,
  usage, steered, unqueued, mode.changed; `turn` on every turn event; thread.text `block`;
  thread.tool `call`/`name`/`status`; thread.finished `total_cost_usd`, `canceled`; cost_usd is the
  turn's own; send answers `queued_id` and `uuid` when queued; answer repeats return `already`.
- modules: manifest `does.providers`, ctx.provider / ctx.providers; callerKind strips :thread:.
- threads: new tool `threads.interrupt`; records carry `driver`; `thread.stopped` reason `idle`;
  `threads.start`/`launch` can refuse with code `busy` (sessions.max_live); manifest needs.vault
  claude-setup-token, anthropic-api-key.
- runner.js: argsFor takes `system` ({mode, text}); run() returns `interrupt()`.
- fake-claude.js: launch log written at initialize (argv normalised, SDK init fields added as
  flags); interrupt support.
- presence: PERSON_ONLY gains sessions.prompt.set, sessions.prompt.revert.
- daemon/client.js: request opts.socket; VYRE_SOCKET used when no root or socket given.
  cli/daemonctl ensureUp: inside a session (VYRE_SOCKET + VYRE_THREAD) only pings, never starts.
- sessions config: spawner defaults "on" for role box; new thread_socket auto|on|off.
- threads.mode enum adds bypassPermissions; mode.changed {label}; sessions.mode.get/set/resolve,
  event mode.defaulted; presence PERSON_ONLY adds sessions.mode.set. Fake claude honours the
  permission mode and runs plugin PreToolUse hooks in bypass.
- sessions.prompt scope "capsule"; sessions.prompt.compose/preview take purpose "capsule".
- onboard: CREDENTIAL_READERS gains threads.
- New module sessions: tools sessions.status, setup, prompt.get/set/history/revert/preview,
  internal prompt.compose; event prompt.changed.

## 2026-09-30 rebase onto stage/0.2 795a00b7 (platform 12a09627 landed)
- work/sessions-02 rebuilt as 31 cherry-picked own commits on 795a00b7 (merge 3e1eef47 and 40f007ca dropped); de16d00d's core/daemon/peer.js hunk dropped (platform owns it), its other hunks kept. One conflict (core/modules/index.js: ctx.call keeps platform's undeclared-tools check plus my onPartial). Old head kept as backup/sessions-02-pre-rebase (f6d3e1f1 tip 434eaa2b). Pushed 066cabaf.
- Next: CI run on 066cabaf, compare failures by name to stage 795a00b7, send sha + diff to reviewer-2 and integrator. After landing: threads.archive/unarchive (github.session.worktree reuses an existing branch; 50ddcffb), four native-core fields, checkCaps from lib/caps-flags, memory.prompt from acp.js (iq b52dd457; agree shape in CHAT.md).
- CI on 066cabaf: sessions-sdk failed once (sessions.test.js finished all tests, then the process did not exit for 120 s: the known runner teardown hang), green on rerun. node run 36668272219 hit the 30-minute cap the same way (last output after the final sessions.test.js test); stage 795a00b7 node is green. Rerunning node.
- Local after rebase (not pushed, waiting for the node rerun on 066cabaf): a724c1a1 daemon catch no longer throws ERR_HTTP_HEADERS_SENT (cause of the flaky "threads watch"); d21e020b threads.lineage; next commit threads.archive/unarchive. Said-row ingress NOT built: needs vault.said.record on stage; contract posted in CHAT.md. memory.prompt shape posted to iq. Still to do: four native-core fields, checkCaps from lib/caps-flags, memory.prompt from acp.js, said ingress.
- Local, unpushed (CI on 066cabaf still running): 9c9f5add memory.prompt into ACP prompts; 74a21031 said ingress + #mentions (core/switchboard/said.js; vault calls fail-soft, vault.items.names/vault.said.record not on stage yet). Not built: threads.mention.stop (waits for vault's revoke shape), checkCaps (lib/caps-flags on no branch). Mac-only failures unchanged vs stage: 4 in core/sessions/sessions-turns.test.js.

## 2026-10-01 real CLIs on a hosted runner (scripts/provider-wire-proof.mjs, workflow proof-wire)
PROVEN with no account and no key: each login command reaches its provider's own address (codex auth.openai.com + a 10-character code; grok accounts.x.ai + a 9-character code; claude claude.com, paste-back) through Vyre's own Signins class; Vyre's ACP driver starts real codex-acp and Grok Build to a first prompt; a REAL Codex turn and a REAL Grok turn ran end to end against a local stand-in for the model (POST /v1/responses, POST /v1/chat/completions). FOUND and fixed: session/new needs authenticate first; `-c` flags do not reach Codex; CODEX_HOME must exist; Codex offers a mode agent-full-access that the old bypass-name denylist missed (modes are now an allowlist: anything unlisted is refused by default, a start in one is moved or refused, a mid-session switch to one is reverted or the session stopped; Codex is narrowed to read-only and agent and pinned to agent on every start); Codex custom endpoints go through the gateway method.
NEEDS THE USER'S REAL ACCOUNTS (added to e2e2's by-hand list): complete a real `codex login --device-auth` and `grok login --device-code` and then a turn (that chat-gpt/grok.com authenticate uses the stored token); a real Claude sign-in with the pasted code; Codex on OpenRouter needs a model id (the gateway sets the endpoint, not the model; session/set_config_option unproven); Grok's permission round trip (it advertises no modes at all; session/request_permission on a tool call is unproven); a real Codex turn that edits a file (the floor and mode "agent"). No OpenRouter key exists in the eval environment (0 secrets), so no real-model turn was run.

PARKED (reviewer-2 M2): when Codex's `custom` endpoint gets a production caller (the OpenRouter rung), its baseUrl and envKey must come only from a person surface, be https unless loopback, and the key must be bound to that host (a key never sent to another). Today only tests and the proof use it, and grokConfigToml already requires https. Not wired, so not built.

## 2026-10-02 relaunch: #20, #56, #40 proof, boundary reds
- #20 (work/fix-20-api-keys 22dca2e5b, pushed): lib/api-endpoint.js (was core/sessions/endpoint.js) `classify()` reads every literal and every resolved A/AAAA as canonical 16 bytes (zone ids stripped; IPv4-mapped in dotted or hex form, IPv4-compatible, NAT64 64:ff9b::/96, 6to4, unique-local, link-local, multicast) and answers loopback, refused or ok. Loopback in any spelling is refused on a box and, everywhere, for Vyre's own ports 7300-7310; a name that resolves to loopback is refused. `resolveSafe` returns the one checked address and `pinnedFetch` connects to it (key check and OpenRouter turns); redirects are refused. Waiting on reviewer-2.
- #56 (same push): recall.thread answers 404 `not_found`, "That session is on a Mac that isn't connected." when no Mac has the session.
- #40 proof: box-image run 36963691040 was red because the SDK's bundled claude, not the global one, answered "Not logged in". work/040-mcp-socket 054cc764f puts the stand-in over every claude binary in the image; run 36969929044 is the proof. This branch also carries 81f8c99f3, so it needs the lib/mcp-config.js move below when its node job runs.
- Boundary reds: switchboard imported core/sessions/mcp-config.js. It is now lib/mcp-config.js (pure, no feature state) on work/022-claude-connectors (059260a77), 022-cx-connectors (9602a0f17), 022-purposes (856c8b500, plus the regenerated CLI reference 4a66602c5) and 022-taint (12aba79f2). All pushed once.
- Next: read the #40 run; if green, merge the mcp-config move into work/040-mcp-socket. #41 and #32 are not mine.

## 2026-10-04 resume after the usage limit (work/flows 9b810f444)
Done: ST-3 (afed69cd1: at("first prompt") and at("first prompt send") after the spawn, send refuses on a cancelled start, seam VYRE_TEST_START_PAUSE_MS, two real-daemon tests); sessions.test.js 142 of 145 (13f457746; also fixed a missing callerKind import in core/sessions/index.js); account.changed (9991ad958: added, key, sign-in ended, confirmed, removed; no credential in it); Kits' lookups read a row by the key its body names and refuse two rows for one key (9b810f444; the flows test kernel now answers membership, which also greens the restart test).
Doing: the stuck dev-box start (waiting on devbox's last `start step` line); compose volume for `<home>.sessions` (proposal sent to launch).
Needs from others: devbox, whether the person's cli threads.start naming `account` is refused on the dev box (sessions.test.js tests 20, 62, 63 stay red until decided: threads.start declares no `account`, so the undeclared-key rule refuses it).
