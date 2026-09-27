# integrator

Branch: work/integrator · Worktree: ../vyre-integrator · Merges into main at ../vyre (never pushed)

## Scope

Own merges into main, one at a time, with targeted tests on the test box after each and a full suite on
the test box when it matters. Keep the suite green on the test box (Linux, node 22, the box image's node).

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
- rc.2 waits on: glass (14f1824c HELD by reviewer, 2 HIGH; take only a sha reviewer signs off) and e2e's fix
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
- windows 63156fe9 (Tier A+B, ADR 0037, test-windows job non-blocking), AFTER e2e reads the win32
  role-default change in core/config; windows will ping.
- docs 40dcb26d (supersedes 53bbc146): ADR 0038 terminology, glossary, docs-check terminology rule
  (hard-fails docs-owned pages only).
- memory-iq's 0.1.1 sha (memory.ask stream: true cutover, around ffae4f08) BEFORE capsule-pro's
  Capsule change that depends on it; memory-iq coordinates, target 30 Sep.
- mac test guard: branch work/mac-test-guard 6a2bb019 (worktree ../vyre-integrator-guard): tempHome and
  tmp-guard refuse on darwin unless VYRE_ALLOW_MAC_TESTS=1; capsule-mac sets it. Mac refuses, testbox 34/34.
- HOTFIX first when it comes: work/glass-hotfix (vyred-only bearer on docker-api). After reviewer's
  sign-off: fast-forward main, targeted run, tell box-deploy to redeploy (backup first). Then merge into pre/rc.
- Reviewer (security) now signs off shas. Cleared for 0.1.1: teammates 9d9e6688 (on 20d0f121, fixes its LOW; supersedes b19f10c2),
  memory-iq d0b916b9 + 7ee03df6 (together). HELD: windows cac517d4 (MEDIUM).
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
