# records

Branch: work/records (off work/rc-0.2.2, work/kernel merged in) · Worktree: ../vyre-records · Owner session: records

Scope: `records/` (the language, the Kits, the Stripe connector, the stand-in gateway for tests) and `stores/twenty/` (the Twenty store, provisioning, the fake Twenty and the live runs). Contract: team/0.3/SPEC-core-contract.md sections 3 and 5, team/0.3/SPIKE-twenty.md, kernel/contracts/store.d.ts.

## Done

- The language (`records/language`): source-only parser with limits and a worker wrapper, the SDK vocabulary, an Expression language, the compiler and checker, the canonical printer, a CLI (`node records/language/cli.js compile|print|check`). Types compile to the kernel's `TypeDefinition`. Mutation fuzz (1,500 files, 3,000 expressions) found one real bug (a temporal-dead-zone in `defineStage`), fixed.
- The first Kit (`records/kits/estate-planning`): Contact with a sealed SSN, Matter with six stages made of tasks, a Welcome email template, Research and Intake teammate roles and an Attorney role, a board view and an On payment flow. `kit.json` is the checked-in stored form (a test keeps it in step with `kit.ts`).
- The Twenty store (`stores/twenty/store.js`): the kernel's Store interface over Twenty, ids kept, versions by a `vyreVersion` column with a compare-and-set on it and on Twenty's `updatedAt`, soft delete and restore, cursor paging, native filters and sorts, aggregate through the kernel's own, search, a change log, export in checksummed chunks, the version hash and `verify`, the signed webhook feed with snapshots for "before".
- Conformance: the kernel suite passes 14 of 14 on the fake Twenty (CI, offline) and 14 of 14 on a real Twenty v2.44.0 on testbox (`stores/twenty/live/run-on-testbox.sh`). The store's own suite adds 9 tests (race, outside edit, webhook-only discovery, own writes not echoed, hash, sealed, ids, webhook security, aggregate and search over sealed) and passes on both.
- Provisioning (`stores/twenty/provision.js`): one Twenty per Space, compose with no published port and an internal network, per-Space secrets (0600), headless service user, workspace and key in about 8 s, instance admin credential kept out of the gateway's reach, empty front end mounted over the UI, firewall rules as text, upgrade with a database backup first, verify before reopening, rollback with the old image. Proven from nothing on testbox: 178 to 207 s to a provisioned Space on a loaded machine, kit types installed in 13 s.
- The Stripe connector (`records/connectors/stripe`): signature check, test mode only, four event kinds, `payment.received` written once per payment, the Kit's flow finds or creates the contact then the matter. Six concurrent deliveries of three events for one payment made one contact and one matter against a real Twenty (340 ms).

## Runs (testbox, 3 Oct 2026)

- Live conformance: `stores/twenty/live/run-on-testbox.sh twspike` against Twenty v2.44.0, 24 of 24 (kernel suite 14, own suite 9, listener). Output kept in the session only; rerun to reproduce.
- Provision from nothing: `node stores/twenty/live/provision-live.mjs livetest3` (191 s), then `stripe-live.mjs livetest3 <home>`; torn down with `docker compose -p vyre-livetest3-twenty down -v`.
- Spike scripts and results now live in `stores/twenty/spike/`.
- After merging work/kernel 97fe2a0d8: 156 of 161 pass on the Mac; the 4 failures are the kernel golden tests that refuse to run on a Mac (they pass on testbox).

## Doing (3 Oct, resumed after the account switch)

- Merged work/kernel f43c4e570 and work/flows 974d18773. Done in this session: the SDK and the store use the kernel's `link` (record link) and `url` kinds; `records/host.js` (`createRecordsHost`) assembles the real gateway, event log, chain builder and Flow runner over any store, and installs a Kit (types through `kernel.records.define`, Flows approved by the owner). `records/flows/run.js` and the stand-in gateway use are gone: the Stripe connector writes `payment.received` into the log and the Kit's Flow runs on `kernel/flows` (a failed run makes Stripe retry and the retry writes a `payment.received` retry event under a new key).
- `records/core-types.js`: the `task`, `template`, `playbook` and `team_member` record types, defined in every Space by `host.defineCore()`.
- Twenty store: `describe`, conformance revision 2, type names with hyphens and underscores, a Vyre type named like a standard Twenty object (task, note, person) is stored under a `vyre` prefix.
- Provisioning: `provisionSpace({ home, space, memory })` (memory: `"small"`, `"standard"` or four numbers), `backupSpace`, `restoreSpace` (a move: same box or another, new name allowed, secrets and key kept).
- Live run: `node stores/twenty/live/host-live.mjs <space> <small|standard>` on the test box does everything above against a real Twenty, measures memory, backup and move, and tears down. Numbers below.

## Next

- First: read the live numbers into "Runs", set the `small` profile from them, rerun with `small`.
- Wire `host.js` to the platform's real assembly when it lands (it replaces `createRecordsHost`; the pieces it calls are the same).
- Stripe: fixtures only until `VYRE_STRIPE_TEST_SECRET_KEY` exists. Never a live key.
- Stage tasks: entering a stage creates its tasks as `task` records (the kernel's tasks module owns approval truth, the record is the projection the Now view reads).
- Native group-by for aggregate (Twenty has `<plural>GroupBy`); views to Twenty views; Kit diff on update; conformance run wired into `upgradeSpace`'s `verify`.

## Needs from others

- platform: where the Stripe webhook route mounts (the handler is `createStripeHandler({secret, gateway, kit})` returning `{status, body}`), and the Space-level wiring that calls `provisionSpace`, hands the webhook target host to Twenty (`OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS`) and attaches the gateway container to the Space network under the alias `vyre-<space>`.
- platform: applying `firewallRules()` on the box (needs root); the tests only check the text.
- lead: a ruling on kernel `FieldKind` names versus the spec's SDK example (`link({to})` is `ref({to})` in the kernel; the SDK follows the kernel and says so in its error).

## Changed contracts

- `package.json` test script gains `records/**/*.test.js` and `stores/**/*.test.js`.
- None to kernel/contracts. Findings the contract owners should read: Twenty has no row version, so the store keeps one (a `vyreVersion` column, created by `define` on every type); the kernel suite's `changes` expects the store's own writes too, so the store reports them and the gateway de-duplicates by (id, version); `date` fields accept `YYYY-MM-DD` only (the kernel's validator also accepts a date and time); a store must refuse a time-ordered id whose version marker is not 4 only because Twenty does (the kernel's `isUuid` already says so).

- 3 Oct rulings applied: kernel files untouched (type is `team-member`, hyphens only); `payment.received` is one event per payment keyed on the payment intent, and a failed run is resumed by `runner.retry` on redelivery (test: fail, redeliver, one event, one run, one matter). Changed contract: `kernel/flows/runner.js` `retry` now also resumes a `failed` run (finished steps are not repeated); sessions owns the file, please keep it.
- The Twenty store returns an empty list for urls, phones and emails as an empty list (the gateway compares what the store returns with what was asked and refuses a mismatch).
- kernel/flows/e2e/estate.e2e.test.js (sessions) fails against the Kit now that `client` is a real `link`: its fixture patched the old `ref` to text. Sessions to update the fixture.

## Findings (testbox, Twenty v2.44.0)

- Twenty returns an unset text field as an empty string, not null: the store maps it to "absent".
- The single-record query errors with "Record not found" instead of returning null: `get` maps it to null.
- Twenty refuses some names for fields and objects (`address`, `type`, `link`, `field`, `event`...) and would rename them itself: the store appends `Custom` so the name is stable.
- A webhook's secret is fixed when it is created, and Twenty caches its webhook list: a new secret per run races the cache. A Space has one secret for its life; `registerWebhook` is idempotent by a hash of the secret in the description.
- Stale webhooks from an older format kept firing with the wrong secret (676 rejected calls in one run) until the registration cleaned every webhook of the Space.
- The kernel suite wants a fresh empty store per test; against a real Twenty that is "destroy every row of the type, new state folder".
