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

## Doing (after Logout 4, 2026-09-27 14:30 UTC)

- rooms.test.js on main: 10/10 on the test box; memory-iq's failure was its own branch or a run
  under claude on the Mac (peer.js). Routed back to memory-iq.
- DEPLOY GATE: box-image on faee38c9 had skipped the build (detect); on 7880dfa6 it built and
  failed (a lone copy of core/sessions/sdk.js imported config/dialogs.js). The fix landed on
  origin main as 65cbc02a (pushed by another team, same design as my ccffa0ac, which is dropped).
  Local main fast-forwarded to it. box-image on main 65cbc02a running; when green, the lead,
  box-deploy and e2e (headscale) get 65cbc02a. ci's 6b16be62 fixes detect (builds from the npm
  pack list).
- idle RSS on main 7880dfa6 (test box, rough, under load): mean 119.8 MB, max 158.9 MB. ci bisects
  3a/3b (work/ci-rss-bisect). Batch 4 does not land until that is fixed.
- BATCH 4 staging: pre/batch4b at 5ca7af66 = main 65cbc02a + docs 3ddc281d, capsule-now
  28246cd0, capsule-agent 42e8da05, app-design be98d494, capsule-apps e99b09d, teammates b5934a4f,
  platform e8e3d902, memory-iq 5985f489, e2e 0856b9b9, polish-cli 5ac697c8, tailnet a7365a99, plus
  fixes: the CLI vault-window CHANGELOG entry polish-cli's branch lost, --popover out of deck.css.
  Full suite on the test box (before the popover fix): 3021 tests, 2941 pass, 3 fail (tokens:
  fixed; vault watch and memory p95 7.1 ms: load flakes, 38/38 on rerun), 74 skipped, 3 todo.
- Check with memory-iq: 5985f489 removes most of core/memory/personal/model.js and its test (the
  reader 07f5c3ca replaces the model pass adc1a94b?).
- Parked: federation 98048454 (conflicts in daemon, link, switchboard; its owner merges main).
- Waiting for ready shas: mobile, capsule-pro (capsule-mac green), pwa, ci. ci-boundaries LAST
  (it has not merged main).
- State.swift after the capsule-agent merge is not compiled yet: capsule-mac on the batch.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
