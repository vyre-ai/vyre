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

## Doing (after Logout 4, 2026-09-27 14:15 UTC)

- rooms.test.js on main 7880dfa6: 10/10 on the test box. memory-iq's failure was its branch (213
  behind main) or a run under claude on the Mac (peer.js refuses person-only calls there). Routed
  back to memory-iq.
- DEPLOY GATE: box-image on faee38c9 was a skip (detect), not a build. On main 7880dfa6 it builds
  and FAILS: box/Dockerfile imported a lone copy of core/sessions/sdk.js, which now imports
  core/config/dialogs.js. Fix on int/box-sdk-pin, pushed as work/integrator-box: ccffa0ac (pin in
  core/sessions/sdk-pin.js, no imports; sdk.js re-exports) + d95c34c8 (guard test in
  test/box-init.test.js). Targeted on the test box: 131 tests, 0 fail. box-image run 36324676019
  queued (Actions saturated). ci (work/ci-sdkver) and e2e (work/e2e-sdk) pushed the same fix;
  land whichever is green first, then box-deploy and e2e headscale get the new sha.
- idle RSS on main 7880dfa6 (test box, Node 22, started under load 10, rough): mean 119.8 MB, max
  158.9 MB FAIL. So the jump is mostly in 3a/3b, not batch 4. Sent to ci (bisecting on
  work/ci-rss-bisect).
- BATCH 4 staging: pre/batch4b on int/box-sdk-pin, at 2eeda1e7: docs 3ddc281d, capsule-now 28246cd0
  (Electron copies out), capsule-agent 42e8da05 (State.swift: queued-turn rule plus main's
  per-reply turn after the hand-over), app-design be98d494, capsule-apps e99b09d, teammates
  b5934a4f, platform e8e3d902, memory-iq 5985f489, e2e 0856b9b9, polish-cli 5ac697c8, tailnet
  a7365a99 (hostedOrigins in core/config, main's presence lists kept). Full suite running on the
  test box: ~/vyre-ci/int-b4.log.
- Parked: federation 98048454 (conflicts in daemon, link, switchboard; its owner merges main).
- Waiting for ready shas: mobile, capsule-pro (capsule-mac green), pwa. Then ci, ci-boundaries last.
- State.swift after the capsule-agent merge is not compiled yet: run capsule-mac on the batch.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
