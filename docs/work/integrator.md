# integrator

Branch: work/integrator · Worktree: ../vyre-integrator · Merges into main at ../vyre (never pushed)

## Scope

Own merges into main, one at a time, with targeted tests on the test box after each and a full suite on
the test box when it matters. Keep the suite green on the test box (Linux, node 22, the box image's node).

## State at restart (2026-09-28, ~00:50 UTC, usage-limit prep)

**rc.2 (pre/rc):** head is `e0c578ad` (= a5eff01f's merge + the rc.2 version bump 0.1.0-rc.1 ->
rc.2 applied directly to package.json/package-lock.json x2 + harness/.claude-plugin/plugin.json,
since work/ci-rc 5b1c5b33 was stale against everything landed tonight). NOT pushed to main yet.

- Full suite run 1 (fresh env, `npm test`): 4024 tests, 3931 pass, **0 fail**, 90 skipped, 3 todo.
  BUT posttest tmp-guard failed: 8 leaked temp homes, 6 were live `vyred-present.js` processes
  still running 19+ min after the suite finished (killed and cleaned by hand). AND both shellcheck
  tests (test/box-update.test.js's two) were skipped ("shellcheck not installed"/"no shellcheck
  here") even though /usr/bin/shellcheck 0.9.0 is on testbox's default PATH and both files pass
  when run directly (`node --test test/box-update.test.js` finds and runs it). Root cause of the
  skip-under-npm-test not found; team-lead's read is a sanitised PATH somewhere in the harness —
  logged as a 0.1.1 task below, not an rc.2 blocker (lead's call, since CI's node job runs
  shellcheck too and must be checked green on the pushed sha).
- Full suite run 2 hung for real (not load): stuck on core/cli/commands/threads-sessions.test.js
  for 11+ min, killed. Ran that file alone 3x with `timeout 120` on testbox: 18/18 pass every time,
  ~30-33 s each. Conclusion: load contention (other teams' concurrent testbox runs), not an rc.2
  bug. No need to loop in e2e on this.
- Full suite run 3 (`--test-concurrency=4 --test-timeout=90000`, tmp-guard run by hand
  before/after since bypassing the npm script wrapper) was killed mid-run for this restart-prep
  window; log is at `/tmp/rc2-full3.log` on testbox but incomplete/no final summary. testbox is
  clean now (no leaked homes, no orphaned vyred-present processes of mine; left another team's
  own processes alone).

**Next for rc.2 (in order):**
1. Rerun the full suite one more time (concurrency-limited is safer given other teams share the
   box; check `uptime` first, hold if load is high) and get a clean 0-fail, 0-leak result.
2. Confirm both shellcheck tests pass when run directly (already shown true above) — that alone
   satisfies the lead's criterion 2, no further action needed unless they want it re-verified.
3. Push `main` from pre/rc's `e0c578ad` (or later, if the rerun adds a fixup commit).
4. Watch CI's node job (and box-image) on the pushed sha; confirm shellcheck is green there.
5. Report sha + numbers to team-lead, then tell box-deploy to deploy. NO tag, NO release — user's
   call only, via team-lead.

**0.1.1 stage (`stage/0.1.1`, worktree `../vyre-stage-011`, pushed as `work/integrator-0.1.1`):**
head `7f71b682`, built off main `4fd286d7` (pre-rc.2 safe-git). Contains, in order: projects
`e87f63df`, cohesion agentClaim `1a8bf671`, memory-iq `c5cfd005`+`2ecf79ba`, connectors `b3bbec29`,
launch `cc24ac19` (superseded — see below), box-deploy `2ce5150d`, plus a fix of my own:
`core/vault/envfiles.js`'s `gitState()` called `execFileSync("git", ...)` directly, unguarded —
converted to `lib/git-safe.js`'s `gitSync` (reviewer-cleared, testbox 359/359). **This stage still
needs a rebase onto the post-rc.2 main** once rc.2 pushes (the lead's instruction: rc.2 first, then
rebase stage/0.1.1 onto new main — the onboard casing fix disappears as a diff there since it's
already in main).

Cleared heads not yet folded into stage/0.1.1 (take exactly these, newest first supersedes):
- launch: `a206ad6d` (supersedes `cc24ac19`, reviewer-2 cleared the chain)
- native-core: `215bed2d` (reviewer-2 cleared)
- teammates: `4d2defee` (supersedes `b720a002` and `work/teammates-a` entirely incl. `5dfa6b41`
  and `60b42d3d` — land ONLY 4d2defee, nothing else from teammates)
- federation: `85bc9ec5` (supersedes `87b2a243`; step-2 fix `63af8941` is HELD, migration-ordering
  MEDIUM — do not take)
- chat: `18980d2d` (sight strip/screen-still, reviewer-cleared, 1 LOW with chat) — reviewer also
  cleared `d9d1cafb`'s core/transcripts half (strict base64 + 12 MB image budget) but its UI half
  needs reviewer-2 too before taking that sha; `9fd902ac` and `62b254f4` are earlier/parallel chat
  shas, check with reviewer-2 which head is actually current before landing chat
- pwa: `082915b8` (open-redirect fix, cleared)
- onboard via-staleness (0.1.1, NOT rc.2): `work/e2e-onboardvia-main` `7bf34043`, off main,
  reviewer-cleared, cherry-pick of `cd376351`

Held, do not take: teammates slice B alone (HIGH: vyred runs project tests as itself — but
4d2defee/b720a002 already fold slice B in, cleared); glass-live (`a9d57668` cleared conditionally
for a LATER 0.1.x train, gated on glass running `isolation.test.js` live on a throwaway stack
first — not this stage); federation `63af8941`; teammates `work/teammates-a` (any sha) once
`4d2defee` is taken instead; connectors/launch/box-deploy anything past the shas listed above
unless a new clearance message says otherwise.

## 0.1.1 task: test hygiene gaps found during rc.2's full suite (2026-09-28)

Not an rc.2 blocker (lead's call). Two confirmed sources, `t.after` kills without waiting or
removing the home:
- `core/cli/screen/screen-live.test.js`: `t.after(() => { try { process.kill(up.pid, "SIGTERM"); }
  catch {} });` — no wait, no rmSync of the tempHome-managed dir's leftover state.
- `core/vault/login-keychain.test.js` (first test, ~line 64): `t.after(() => { try {
  child.kill("SIGTERM"); } catch {} });` — same pattern.
Compare `test/vault-cli-totp.test.js`'s `vyred()` helper, which does it right: SIGTERM, wait up to
5 s for `child.exitCode`, then `fs.rmSync(h, { recursive: true, force: true })`. 4 more leaks in
that 8-leak run are unexplained — only 2 call sites found via grep for `vyred-present`/`upPresent`;
worth a broader audit of anything spawning a real vyred and killing it in `t.after` without
waiting, next time someone has the cycles.

## Done (2026-09-27)

- Baseline on the test box at bfbfd69: 1445 tests, 21 fail, all from the machine (node 22 has no
  argon2Sync, node 22's SQLite warning mixed into JSON, real Docker on PATH, Linux defaults to
  role box, Mac helper tests not skipping, the journey's fake operator), plus the journey race.
- 18a980a merge journey-flake: once the address serves, journey 1 finishes from the box's
  terminal (`vyre call` through the wrapper), since box add closes the tunnel then and the
  harness cannot reach the address as the owner. Journeys 1 to 6: 3 runs in a row green on the test box.
- fd21b03 merge integrator: the leaked `vyre-test-*` home holding only vault/ came from the
  vault's start-up shared-vault pull, which made a key and identity with no shared vaults and
  fired 200 ms after start, after the test had removed its home (3 leaks per full run, from any
  in-process vyred: link, computers, switchboard tests). Fixed in core/vault (shared.sync does
  nothing with no rows; vault.later/stop). tempHome records its test in `<SCRATCH>.homes` and
  tmp-guard names it. Plus the test box test fixes. Full suite on the test box: 1449 tests, 1406 pass,
  0 fail, 42 skipped, `npm test` exit 0, tmp-guard clean.

- 1b3a457 merge polish-surfaces: world.js theirs; scratch/tmp-guard/vault tests/helper test kept
  both sides; the dialog-fix touchid gate test moved under SCRATCH (os import was gone). Full
  suite on the test box: 1453 tests, 1409 pass, 0 fail.
- a8b6520 merge tailnet (tailnet-surfaces included): policy.test imports, entrypoint egress PAC
  plus --test-type, Chat session head plus health dot, all kept both sides. Full suite on the test box:
  1578 tests, 1535 pass, 0 fail, 42 skipped, 1 todo, exit 0, tmp-guard clean.

## Done after the rewrite (2026-09-27)

- 80f2b44 pwa, 5524dd8 capsule-now, d0e35c3 connectors (at 53a994a; 2483c77 awaits approval),
  c4bf9ea cc-plugin, 7a97230 polish-cli, 439f35a security (registry rules for every non-person
  caller; vault.caps reveal described as it is, with a real-presence test) plus two flake fixes.

## Tonight (2026-09-27), all pushed to origin
- 244a643 pwa, 48f8a01 e2e (+ ownerOverTailnet shared by callerAllowed and registryRules),
  d962b04 federation, 12dc0c9 glass-live, d51dd69 ci, d6bb815 node 24 isClaude fix,
  8be1c52 polish-cli, 3d0295f connectors, 7b54493 onboard.finish api-key auth.

- Later: 86bcf0a polish-cli (CLI presence), 205387e e2e, dee1028 pwa, 22443e3 tailnet,
  796bdcb phone-design, 246af82 docs, f3b5e36 SPEC 5.2 ctx.call. Full suite at f3b5e36 on the
  test box: 1917 tests, 0 fail, exit 0.

## Done: 0.1.0-rc.1 landed (2026-09-27 ~19:55 UTC)

- main = ac60d3c5 (fast-forward from 68463d04). Not tagged: the tag is the lead's and ci's call.
- Full suite on testbox at a435d516: 3765 tests, 3665 pass, 7 fail (up welcome 0.0.1, pwa keep
  list, onboard.css raw tokens, voice usage exit, plugin version, thread.status), 3 todo. Fixed in
  8ff0d6d5 + ac60d3c5; those files plus onboard, docs, hygiene and boundaries rerun green with
  tmp-guard before/after clean.
- rc.2 on pre/rc: e2e-surfaces 5a646023, launch 4d3b808f, hotfix a3a844e4, e2e-agentclaim 1ff45c03,
  cohesion 4b9c0c0d (targeted 144/0). cl.py now checks headings across the whole CHANGELOG.
- rc.2 also: memory-iq 4ff57bb6, pack fix 607fcca0. capsule-pro 4022d388 merged; launch bb2ef63e merged;
  vault f3d39f3f + 17dd7a05 and connectors 8be461a9 merged Six edges frozen as 0.1.1 debt
  (lead OK, 30416e64 + boundaries.md), Capsule IQ model names in the drift list. Waiting only on glass-live.
- memory-iq aaf4fcb5 merged (9cac53a0). main's two node reds fixed (09f5e02a).
- e2e-peerfix a8eee5dc (072fab3d) + follow-up ae9c6cdc (a007577f, reviewer cleared; testbox 92/92).
- rc.2 BLOCKER: e2e's lib/git-safe.js fix (vault's gitState/gitWarnings run a planted core.fsmonitor as
  vyred's uid), built on pre/rc, reviewer-cleared. Also a main hotfix, with glass's docker-api hotfix if
  they are ready near the same time (fast-forward, targeted run, box-deploy redeploys after a backup).
- Hotfix shas so far: glass 0f17b106 (on 779cc852, adds /var/lib/vyre-secrets; e2e passes a real stack), waiting
  for the reviewer. safe-git: pre/rc work/e2e-safegit 9efb1851, main work/e2e-safegit-main a26793cd (NOT 9eb2ee32/2f43126d); land only when the reviewer clears THESE heads.
  Land 0f17b106 the moment it is cleared (do not wait for e2e's crash-loop follow-up, its own sha later).
  box-deploy confirms computers.list works and docker-api is stable after the redeploy.
  work/docker-api-hotfix (cohesion b54d2521) is DROPPED by the lead: never land it.
- rc.2 candidate, NOT gating: cohesion agentClaim parser (5ef364c3 + fix sha) once e2e AND reviewer sign
  off the fix sha. If glass is ready first, land without it.
- rc.2 waits on: glass (14f1824c HELD by reviewer, 2 HIGH; take only a sha reviewer signs off). Was also e2e's fix
  sha for the macOS hang in 1941f2cf's per-connection peer check (ps or perl).
  MUST also take glass-live's rebased sha (two e2e HIGHs: container Env secrets, unfenced CDP), via
  e2e; its computer image rollout goes with box-deploy. Waiting: vault-next
  (HELD for e2e's sign-off on the send_mail takeover fix) + connectors 8be461a9, then ci bumps to rc.2.

## Earlier: the RC batch on pre/rc (2026-09-27 ~19:00 UTC)

- Merged on pre/rc: native-core 6ccad201, platform e75a6a11 + settings-write d62792d0,
  app-design-hub 9a6abbcf, cohesion 0f4d1105, sessions db4af9c3 + 501ca3fc, memory-iq 1a76d383,
  chat ff62e37b, pwa c78b87c0, mobile 01068595, polish-cli 12851fab, docs ecdb22eb, e2e daf63e22,
  then native-core-composer c012c13c (sessions.models reads MODEL_ALIASES), platform a79d58f1
  (vyre module; CLI group keeps "commands"), sessions e8fd0e42, memory-iq 1815b37d, chat 0b6f9091,
  e2e 88610b5e, capsule-pro a127335d, ci 35bfed5f.
- Waiting: vault work/vault-next (green sha from the vault team) with connectors 8be461a9.
- Then: full suite once on testbox, ci-rc 1d8ae652 LAST, push main, report to the lead.
- testbox has no shellcheck; a user copy is at ~/.local/sc/shellcheck-v0.10.0 (put it on PATH for the
  full suite, as CI has it).
- Generated docs on a conflict: take ours, rerun `node scripts/gen-docs-reference`.
- Fixes on pre/rc: 75148174 onboard reserve test waits for its claim (tmp-guard leak), ae6fe249
  switchboard fake key built at run time (hygiene), 2913b069 drift allowlist shrinks. Targeted run
  after them: 1129 tests, only the drift allowlist failed, now 2/2.
- Launch: 342e02f5 merged (b662d5da, same tree as d61fd341; the lead said keep it). Follow-up 57eebd9f
  merged (violet fills gone).
- capsule-pro 0a7d7f53 Design A merged (supersedes a127335d and streamfix 686520d1).
- launch acca5cbc + c81244a1 merged. e2e-label 1941f2cf merged (cb1f8e66): a person's label from
  under a claude is "mcp". When vault + connectors land, check mail and on_behalf are covered by it
  too. Suites that call as "cli" run on testbox only, never under a claude.
- rc.1 = pre/rc a435d516 (ci-rc 1d8ae652 in; no vault, no connectors), full suite on testbox.
- rc.2 queue: vault-next HELD (a1a4e0b8 has an e2e HIGH: connection takeover reroutes send_mail; wait for e2e sign-off on the fix sha) + connectors 8be461a9 (check mail and on_behalf
  under e2e-label's rule), launch 4d3b808f (CSS), then ci bumps to rc.2.

## Done after Logout 3 (2026-09-27)

- Full suite at ef51363 on the test box: 2085 tests, 2047 pass, 1 fail (google OAuth, real: the
  planner's calendar mirror reads a window on google.added). e671d35 fixes the count (test only);
  e671d35 = deploy candidate. 123e70f6 switchboard realpath (Mac /var vs /private/var).
- b1dbb49b cc-plugin a081ad15 alone (SECURITY: vault Read when vyred says denied): cc-plugin +
  harness 33/33, learn + about 117/117.

## Done (2026-09-27, after Logout 3)

- main e671d35 (google test), 123e70f6 (switchboard realpath), b1dbb49b (cc-plugin vault Read fix),
  15e82dd7 (batch 1 + term save fix), 78b0752a/9efbddc0 (docs/design out of the package, cap 12 MB),
  c8fb9aae (batch 2: relay, native Capsule, resilience, tokens, docs; eval said.js),
  fb1ed1d1 (3a: sessions 4311fca5 with the SDK default, chat fb0694d, chat contract 6182766).

## Done: batch 4 landed (2026-09-27 18:50 UTC)

- main = bc751624 (pushed), fast-forward from 53cd1326. Contents: docs 393b7c97 (tips), capsule-now,
  capsule-agent + capsule-pro 170dac3b, app-design be98d494 (specs), capsule-apps e99b09d,
  teammates, platform a1c3fbfc + b4fix 97686e1b, memory-iq 0f0c17a2, e2e 4e5a27f7, e2e-noclaude
  88c90d56, polish-cli 4bc5c14b, tailnet a7365a99, mobile 8bc3b5b1 + 48f84c63, native-core 3ae4fc93,
  settings-write 70242656, chat 0f5402c6, pwa 2a577ede, cohesion f5cd36f7, sessions 51eaa964 +
  e9d734c7, ci d4cb2610, ci-boundaries de5651bf (last).
- Integrator fixes: f67144f3 bare tailnet caller, 91f34bae module-sdk schema/types, d49d535e
  chat CSS on the 719 query and radius roles, cdd4b768 + 72e1a2dc drift freeze with owners,
  f7226849 settings claudeHome, de3c1e9e five edges frozen, 63d943f5 theme test via roles,
  daemon.test close, bc751624 waiting leaves the planner to the box on a Mac.
- Checks: full suite at f7226849 3482 tests (fails since fixed or known flakes); targeted rerun at
  bc751624 on the test box, all green: daemon, federation-reads, waiting, theme, deck-contract,
  chat contract, cohesion-drift, boundaries, module-sdk, docs-*, hygiene, system, sessions,
  journey, temp-home guard.
- Debts after 0.1.0: the five sessions/switchboard edges (sessions); drift copies (mobile x2,
  native-core, capsule-pro).

## Next: 0.1.1 batch 1 (right after rc.2 lands)

- federation 9338a6a5 (supersedes aa9cb40c; e2e signed off: fail-closed ask checks, persisted nonces, files.deliver opt-in).
- windows e56c45e9 (on 8cd4722d; Tier A+B, ADR 0037, test-windows job non-blocking; reviewer cleared).
- docs 40dcb26d (supersedes 53bbc146): ADR 0038 terminology, glossary, docs-check terminology rule
  (hard-fails docs-owned pages only).
- memory-iq's 0.1.1 sha (memory.ask stream: true cutover, around ffae4f08) BEFORE capsule-pro's
  Capsule change that depends on it; memory-iq coordinates, target 30 Sep.
- mac test guard: branch work/mac-test-guard 6a2bb019 (worktree ../vyre-integrator-guard): tempHome and
  tmp-guard refuse on darwin unless VYRE_ALLOW_MAC_TESTS=1; capsule-mac sets it. Mac refuses, testbox 34/34.
- HOTFIX first when it comes: work/glass-hotfix (vyred-only bearer on docker-api). After reviewer's
  sign-off: fast-forward main, targeted run, tell box-deploy to redeploy (backup first). Then merge into pre/rc.
- Reviewer (security) now signs off shas. Cleared for 0.1.1: teammates 9d9e6688 (on 20d0f121, fixes its LOW; supersedes b19f10c2),
  memory-iq d0b916b9 + 7ee03df6 (together). windows 8cd4722d cleared (with cac517d4 + 63156fe9).
- connectors 482f7b6d (21beb66b e2e-signed; then 9ca2c50a discover fixes, vault-next merged, Connections card;
  kernel add: core/config claudeJson()). Needs sign-off on 482f7b6d itself. vault-next is already in rc.2, so it
  is on main before batch 1.
- memory-iq batch 1 head 0a7ea3e7: fd7f57ab + 0a7ea3e7 cleared; e67ba34d (memory.card) HELD (MEDIUM: a
  project agent's card lists other projects). Wait for the reviewer's cleared fix sha before taking the head.
- box -> server (ADR 0038): core/cli user strings listed by docs; I asked docs to route them to polish-cli with
  the vyre server rename (one pass, no conflicts). If the lead gives them to me: 0.1.1, after rc.2.
- box-deploy 2ce5150d (ADR 0038 sweep of `vyre projects` strings; docs/reference/cli.md regenerated).
- teammates b19f10c2 (core/team, ADR 0031 step 1; e2e signed off). It carries a cherry-pick of 1941f2cf
  in core/daemon/index.js, already on main: expect a trivial conflict there.

## Older: batch 5 queue

- native-core ac34c322 hub step 1 (after e2e review), app-design b756d128 (core/appearance),
  platform 7398763b, mobile 503414d4, pwa 34195805, sessions db4af9c3 (501ca3fc held for e2e's
  split check), vault-9a f4272358 (+9b with connectors f71009d9 once on_behalf HIGH is fixed),
  memory-iq later WIP, chat tip after 0f5402c6, federation after 0.1.0.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
