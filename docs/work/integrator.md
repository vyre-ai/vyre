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

## Doing

- Waiting on the lead: merge work/polish-cli now or after its lock work and stress run (asked).
  work/connectors waits for its lead's ready.

## Next

- polish-cli, then connectors: one at a time, full suite on the test box, report sha and numbers.

## Needs from others

- Lead: RULES.md's the test box recipe could note that the suite now passes there with plain node 22
  (no NODE_OPTIONS needed).

## Changed contracts

- `bin/vyre` loads `core/quiet.js` first (drops only node 22's SQLite experimental warning).
- `core/vault`: `Vault.later(fn, ms)` and `Vault.stop()`; the module's stop calls it in place of
  `lock()`. After stop, `key()` refuses with code `stopping`.
- `core/vault/testing.js` exports `TEST_KDF`.
