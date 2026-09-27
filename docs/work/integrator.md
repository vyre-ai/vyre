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

## Doing (Logout 4)

- pre/3b 291c78f2 (pushed as work/integrator-3b), on main fb1ed1d1: e2e bb0415f8 (person session,
  spawner off by default, symlink floor fix) + 21ac4910 wiring, resilience b8fa344f, relay 104ebcf7,
  pwa 77df33b, capsule-apps 430d8eb, planner f5eb28ac, cc-plugin d381d76b, teammates cfffa0e0,
  ci box-image.yml (0f804c11 file only), capsule-pro 47889399 (Cmd-A), sessions db44749b,
  chat c26f868, e2e-sdk 8aed4887 (journey 4), plus fixes: api.js one person path, drive tests
  signed in, box-init test for the spawner, floor/presence unions.
- Full suite on 6df7efb9 (3b before 8aed4887): 2911 tests, 2833 pass, 1 fail = journey 4, which
  8aed4887 fixes. Targeted journey + sdk-install + sessions on 291c78f2 was running at logout
  (~/vyre-ci/int-3b-j4.log on the test box).
- Next: if that is green, fast-forward main to pre/3b, push, send the sha to box-deploy (it includes
  e2e: all four gates; recreate vyre and docker-api only, egress stays uncreated, tailscale
  untouched; the uid split is off by default).

## Next: batch 4 queue (rebuild on main after 3b; ci-boundaries LAST, then boundaries.test and
list any new edge for the lead; core/cli/qr.js -> deck/vendor/qrcode.js is pre-approved)

- Staged on pre/batch4 (from c8fb9aae, to rebuild): docs a286b900 then 3ddc281d, capsule-agent
  42e8da05, capsule-now 28246cd0 (before agent; Electron copies stay out), capsule-pro 5d4d642b ->
  now e0dca278 once capsule-mac 36323645897 is green, glass-live 4b88f1d9 (HOLD off main until its
  throwaway-stack validation; ships with new vyred + docker-api + computer image), app-design
  7e554a0e -> be98d494, ci 1b1c8573, capsule-apps e99b09d, ci-boundaries de5651bf, platform
  2e6997dd -> ab34605c, teammates bc41402e -> b5934a4f.
- Queued, not staged: e2e e5aaf881, e2e 9fc65458 (auto-pair), federation 98048454 (after sessions'
  review), tailnet a7365a99, mobile cb4e988c (regenerate tokens.ts), polish-cli 7d2f9c32, memory-iq
  b220517b (new migration), relay ee067714 (already in 3b via 104ebcf7), pwa 459b181+ (its api.js
  replaces chat's stream section with onResume).
- After batch 4: vault-next 115c5466 (migrations appended; ADR 0028 in nav between 0026 and 0029).
- BLOCKED: native-core (77faf1e3 etc.) until e2e re-reviews the settings.set person-only and CALL_AS
  fixes; check the claude-code.md docs failure then. platform-settings-write e4515fb6 after it.
- Rules learned: launch suites with setsid (e2e's orphan rule refuses a backgrounded shell);
  test/deck-contract.test.js in every targeted set; load under 8 before any testbox run.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
