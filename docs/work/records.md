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

## Doing

- Nothing in flight. Waiting on the lead's merge and on the platform's gateway to replace `records/testing/gateway-lite.js`.

## Next

- Run the kernel gateway's own tests against this store (the gateway filters rows and fields itself; this store is untrusted by design).
- Flows: the platform's step runner replaces `records/flows/run.js` (it runs only the `find` verb the Estate kit uses).
- Native group-by for aggregate (Twenty has `<plural>GroupBy`); today aggregate scans, capped at 50,000 rows.
- Views to Twenty views and page layouts (the store skips views: the Deck draws them).
- Kit install as a grant card (needs platform's grant UI), kit diff on update, templated projects.
- Conformance run after an upgrade, wired into `upgradeSpace`'s `verify` by the gateway.

## Needs from others

- platform: where the Stripe webhook route mounts (the handler is `createStripeHandler({secret, gateway, kit})` returning `{status, body}`), and the Space-level wiring that calls `provisionSpace`, hands the webhook target host to Twenty (`OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS`) and attaches the gateway container to the Space network under the alias `vyre-<space>`.
- platform: applying `firewallRules()` on the box (needs root); the tests only check the text.
- lead: a ruling on kernel `FieldKind` names versus the spec's SDK example (`link({to})` is `ref({to})` in the kernel; the SDK follows the kernel and says so in its error).

## Changed contracts

- `package.json` test script gains `records/**/*.test.js` and `stores/**/*.test.js`.
- None to kernel/contracts. Findings the contract owners should read: Twenty has no row version, so the store keeps one (a `vyreVersion` column, created by `define` on every type); the kernel suite's `changes` expects the store's own writes too, so the store reports them and the gateway de-duplicates by (id, version); `date` fields accept `YYYY-MM-DD` only (the kernel's validator also accepts a date and time); a store must refuse a time-ordered id whose version marker is not 4 only because Twenty does (the kernel's `isUuid` already says so).

## Findings (testbox, Twenty v2.44.0)

- Twenty returns an unset text field as an empty string, not null: the store maps it to "absent".
- The single-record query errors with "Record not found" instead of returning null: `get` maps it to null.
- Twenty refuses some names for fields and objects (`address`, `type`, `link`, `field`, `event`...) and would rename them itself: the store appends `Custom` so the name is stable.
- A webhook's secret is fixed when it is created, and Twenty caches its webhook list: a new secret per run races the cache. A Space has one secret for its life; `registerWebhook` is idempotent by a hash of the secret in the description.
- Stale webhooks from an older format kept firing with the wrong secret (676 rejected calls in one run) until the registration cleaned every webhook of the Space.
- The kernel suite wants a fresh empty store per test; against a real Twenty that is "destroy every row of the type, new state folder".
