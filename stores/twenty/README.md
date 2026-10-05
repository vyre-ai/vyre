# The Twenty store

The business-records store behind the gateway. It implements the kernel's Store interface (`kernel/contracts/store.d.ts`) over one unmodified Twenty per Space, and passes the kernel's conformance suite (`kernel/conformance`).

- `store.js`: the store. `plan.js`: kernel types and values to Twenty metadata and rows. `client.js`: the one GraphQL client (the only holder of the Space's key). `snapshots.js`: what the store last saw of each record, so a change made inside Twenty has a "before".
- `provision.js`: one Twenty per Space (`provisionSpace`), the compose file (no published port, an internal network, an empty front end mounted over the UI), the firewall rules as text, upgrade with backup and rollback (`upgradeSpace`).
- `testing/fake-twenty.js`: a fake Twenty that answers the exact operations the store sends, for offline tests. Not Twenty: the live run is the real check.
- `live/`: the same suites against a real Twenty. `live/run-on-testbox.sh <compose project> <key volume>` runs `live/live.test.js` from a container on the Space's internal network. `live/provision-live.mjs <space>` provisions a new Space from nothing and exercises it; `live/stripe-live.mjs` runs the Stripe connector against it.

## How a record is held

| Language | Twenty |
|---|---|
| text, rich_text, link, ref (as the urn) | TEXT |
| number | NUMBER (float) |
| money | CURRENCY (amountMicros, currencyCode) |
| boolean, date, datetime | BOOLEAN, DATE, DATE_TIME |
| choice, stage | SELECT (values upper snake case) |
| multi_choice | MULTI_SELECT |
| rating | RATING |
| actor, file, address, phones, emails, urls | RAW_JSON |
| sealed | RAW_JSON holding the reference value, never a value |
| (every type) | `vyreVersion` NUMBER: the record's version |

The first text field of a type is Twenty's own name field. A name Twenty reserves (`address`, `type`, `link`...) gets a `Custom` suffix on Twenty's side only.

## Versions and outside edits

Every write is a compare-and-set on `vyreVersion` and on Twenty's `updatedAt`. An edit made inside Twenty changes `updatedAt` but not our version, so the next read or the signed webhook gives it the next version, in order, and reports it in `changes()` with a before from the snapshot. A caller holding the old version gets `version_conflict`.

## Run

- Offline: `node --test "stores/**/*.test.js"` (the live file skips itself).
- Live, on testbox: `stores/twenty/live/run-on-testbox.sh twspike` (any Space's compose project, with the volume that holds `twenty.key`).
- Needs on the machine: Docker with compose. The images are named by tag and digest (provision.js: `TWENTY_TESTED_REF`, `POSTGRES_IMAGE`, `REDIS_IMAGE`: twentycrm/twenty v2.44.0, postgres 16.4-alpine, redis 7.4-alpine), the exact images the live suite passes against. An upgrade names a full `name:tag@sha256:...` reference, never a bare tag.

## Operator notes

- Twenty ships its front end; provisioning mounts an empty directory over it, so `/` is a 404. Twenty's MCP, workflow runner and login cannot be switched off by an environment variable: the network is the lock (`firewallRules`).
- Twenty's webhook list is cached and its secret is fixed at creation: a Space keeps one secret for life. Webhooks fail silently when the target host is not in `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` on the worker as well as the server; call `registerWebhook` and send a test change after provisioning.
- Twenty's API rate limit defaults to 100 calls a minute: the compose file raises it.
- Logic functions are off by default outside development: Code steps will not run in Twenty. Vyre's flows do not use them.
