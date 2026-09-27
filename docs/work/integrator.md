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

## Doing (2026-09-27, after Logout 2)

- main (local, not pushed) = 42460e5: d3ed622 + docs d5659d9 (c48959b) + site hygiene b8d98f0
  (no Capsule zip in build-site/release, site/_redirects untracked, clean dirty stamp,
  release-check asserts both redirects, no zip, /start as committed, no node_modules, size cap
  16 MB since the docs make the install 11 MB). release-check --skip-tests passes on the test box.
- fd633bd (local main): docs screenshots out of the npm package (`!docs/**/*.png`), install 8.9 MB,
  cap back at 10 MB, release-check asserts no docs png. Lead's call.
- Waiting for e2e's agents no-passkey reversal (e2e worktree has it uncommitted). Don't take baf6f30.
  Then: merge on main, FULL suite once on the test box (nice -n 15), push, sha to lead, box-deploy, e2e.
- Trial merge of chat 65ce976 (brings federation 2379a0c) on pre/chat 9bd1cf4: only CHANGELOG
  conflicted (kept both); its 21 test files + presence-bypass: 245/245 on the test box.
- pre/chat 61cc14d also has cc-plugin ddf4653 and planner 8acf291 (ADR table: 0024 chat, 0025
  planner, kept both). One failure: test/cc-plugin.test.js "a stand-in planner's tools..." (the
  real planner.add refuses the stand-in's input, bad_input). Asked the lead who fixes it.

## Next

- Trial pre/next: main + chat 65ce976 + tailnet 7e09cb1 (owner-only streams), CHANGELOG only;
  names/service, onboard, federation-send, term, glass: 64/64. Merge both after the deploy push.
- cc-plugin owns the stand-in planner test (rewriting against the real planner.add); planner makes
  "6pm" parse. Merge cc-plugin and planner once those land.

- After the deploy push: chat (redo the pre/chat merge on the new main), cc-plugin 9ce2f18,
  planner e4fbc70, docs tip, capsule-pro when asked. Not mobile until its coral tokens are swapped.
- Route to capsule-pro: `vyre capsule install` still fetches Vyre-mac.zip, which the site no
  longer serves; scripts/build-mac-zip.sh can go with it.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
