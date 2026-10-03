# Spike: Twenty behind a Vyre gateway (testbox)

Run on testbox, 3 Oct 2026, stock images `twentycrm/twenty:v2.44.0` and `v2.43.0`, `postgres:16`, `redis:7`, `node:22-alpine`. Nothing installed on the Mac. Both stacks are stopped (volumes kept) and the box is back to its normal load. Code: `team/0.3/spike-twenty/` (gateway.mjs, bootstrap.mjs, manifest.json, load.mjs, compose.single.yml, compose.multi.yml). Secrets never printed; keys live in 0600 files in the stack directories on testbox.

Result in one line: everything asked works end to end, with three things to settle: Twenty rejects UUIDv7 (workaround below), its webhook carries no "before", and MCP, workflows and login cannot be switched off by env, so network isolation is the real lock.

## 1. Memory and CPU (single Space, v2.44.0)

Idle, 3 samples over 20 s after a 60 s settle (`docker stats --no-stream`):

| Container | RSS | CPU idle |
|---|---|---|
| server | 723 MiB | 0.1 to 0.4 % |
| worker | 966 MiB | 0.3 to 1 % |
| postgres 16 | 70 MiB | ~0 % |
| redis 7 | 11 MiB | ~0.5 % |
| gateway (node 22) | 15 MiB | 0 % |
| **Total** | **about 1.8 GiB** | |

- Right after boot the server sits at 1.1 to 1.25 GiB and the worker runs at 120 to 150 % CPU for about a minute, then both settle.
- Multi-Space stack (2 Spaces, 600 records, after the upgrade): server 1022, worker 969, db 78, redis 14 = 2.1 GiB idle. A second Space's marginal cost was not isolated.
- Under load (gateway to Twenty, 8 to 16 concurrent callers, 1 seed record type): peaks server 1268 MiB / 194 % CPU, worker 883 MiB / 147 %, db 88 MiB / 43 %, redis 15 MiB / 22 %. The server peak includes warm-up after a restart.
- Throughput through the gateway (includes event write and webhook round trip): create 59/s (p50 108 ms, p95 174 ms), get 190/s (p50 80 ms), query returning 100 rows 63/s (p50 126 ms), update 59/s (p50 122 ms). 1,000 operations, 0 errors once rate limits were raised (see gotcha 2).
- Disk: image 1.84 GB, postgres image 642 MB. Cold start (empty db, images cached): 176 s single, 166 s multi, mostly migrations.
- Verdict: about 2 GiB per Twenty is dominated by the worker. Fine for one instance per box, heavy for one per Space. This is the case for IS_MULTIWORKSPACE (item 6).

## 2. Headless setup, no browser

Script `bootstrap.mjs`, plain GraphQL on `/metadata`, about 8 s on a single instance and 24 s with multi (workspace creation 15.6 s, activation 8 s):

1. `signUp(email, password)` for one service user per Space (no email verification needed by default).
2. `signUpInNewWorkspace(input:{displayName, subdomain})`, then `getAuthTokensFromLoginToken(loginToken, origin)`.
3. `activateWorkspace` (without it the workspace has no schema or roles: `getRoles` returns empty).
4. `getRoles`, `createApiKey(name, expiresAt, roleId)` with the Admin role, `generateApiKeyToken`.
5. `updateWorkspace(data:{isPasswordAuthEnabled:false})` with the user token. The mutation was accepted; I did not re-test sign-in afterwards.

The key then drives `/metadata` (createOneObject, createOneField, createWebhook, introspection) and `/graphql`.

What is off or unreachable:

| Surface | State | How |
|---|---|---|
| Network | Twenty, worker, db and redis have no published port and sit on an `internal: true` docker network. Only the gateway is on both networks. `ss -ltn` shows only 127.0.0.1:4001 and 4002. | verified |
| UI | Stock image ships the front in `dist/front` (62 MB). An empty read-only bind mount over it gives 404 on `/`, `/settings` and `/index.html` (Accept text/html), `/healthz` and the API unaffected. | verified after mount; I did not test the html request before the mount |
| Login | `AUTH_PASSWORD_ENABLED=false` did not stop `signIn` (still returned a token). Per-workspace `isPasswordAuthEnabled=false` accepted. The service user has a random password. Unreachable from outside by network. | partly verified |
| MCP | Works with the API key (`/mcp` tools/list returned 200). I found no env switch. Not proxied by the gateway. | verified, only network blocks it |
| AI | No provider key is set, `aiModels` is empty in client-config. | verified |
| Workflows | Workflow objects exist and the runner lives in the worker. No env switch. `DISABLE_CRON_JOBS_REGISTRATION=true` stops scheduled triggers and any other cron it registers (side effects not audited). Logic functions default to DISABLED outside development. | no switch; inert only because nothing reachable can create one |

Open: give the service key a narrower role than Admin (no workflow or tool access). Not tried.

## 3. One record type end to end

- `manifest.json` defines `Matter` in our language (title text, stage with 5 choices, opened date, a sealed text field). `define()` in gateway.mjs diffs against Twenty's metadata and creates the object and 3 fields, idempotent. Our `title` maps to Twenty's built-in label field `name`. Stage choices become SELECT options with UPPER_SNAKE values and are translated both ways.
- Our id kept: gateway mints the id, sends it in `createMatter(data:{id})`, Twenty stores and returns the same value. The gateway throws if it differs. 517 records, all ids ours.
- Query, filter by stage, update: work. Event written by the gateway on each success with actor, `vyre://Matter/<id>`, before and after (sealed value redacted), source `gateway`. 600 gateway writes produced 600 gateway events.
- Change inside Twenty: a direct API call bypassing the gateway raised `matter.updated`, the worker POSTed to the gateway's `/_twenty/webhook`, the gateway verified the signature and wrote an event with actor `store:twenty`, source `twenty-webhook`, `changed:["stage"]`, and a before taken from its last snapshot. The gateway's own 600 writes echoed back through the webhook and were all dropped by matching `id@updatedAt` (0 false external events, 2 true ones).

Gotchas found:

1. **UUIDv7 rejected.** Twenty's validator only accepts versions 1 to 5 (`packages/twenty-shared/src/utils/validation/isValidUuid.ts:3`, and its GraphQL UUID scalar), so `createMatter(data:{id:<v7>})` fails with "not a valid UUID". Postgres is fine with it. Workaround used: same 48-bit time prefix plus counter plus random bits, with the version nibble set to 4. Time ordering and lexical sort are kept. Cost: such ids are not strictly v7. Options: keep this, or send Twenty a patch to widen the regex to 1 to 8.
2. **API rate limit.** Default `API_RATE_LIMITING_LONG_LIMIT` is 100 requests per 60 s per workspace, and `SHORT_LIMIT` 100 per second. 294 of my first 400 creates failed. Set `SHORT_LIMIT=2000`, `LONG_LIMIT=100000`.
3. **Webhook SSRF guard.** Twenty refuses to call private hosts. `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS=gateway` (exact hostname, no patterns) is needed on the **worker** as well as the server. I set it only on the server first; the worker logged the job as "processed" in 4 ms and nothing was delivered. No error anywhere. A health check must send a test event.
4. **Webhook payload has no "before".** Shape: `{targetUrl, eventName, objectMetadata:{id,nameSingular}, workspaceId, webhookId, eventDate, record:{...full record incl. updatedBy.source}, updatedFields:[...]}` with headers `x-twenty-webhook-signature`, `-timestamp`, `-nonce`. Signature is HMAC-SHA256 of `timestamp:JSON(payload)`. The primitives paper says events carry before, after and diff: that holds for Twenty's internal events, not for webhooks. The gateway reconstructs "before" from its own snapshot (works for records it has seen; null for changes to unseen records such as mail-sync inserts).
5. Webhooks are delivered by the worker queue (webhook-queue), so the worker cannot be dropped.
6. Gateway limit in the prototype: `query` returns the first 100 rows with no cursor paging.

## 4. Sealed field

`clientTaxId` is declared `sealed: true`. The gateway encrypts it with AES-256-GCM (key file outside Twenty, record id and field as AAD) into its own store and writes the placeholder `[sealed]` to Twenty. Reads return plaintext to `x-actor: person:*` and `[sealed]` to `assistant:*`. Verified:

- Person view shows `12-3456789`; assistant view shows `[sealed]`; Twenty's own row shows `[sealed]`.
- `pg_dump` of the whole Twenty database contains none of the seeded sealed values (11-1111111, 22-2222222, 12-3456789 and 300 seed values; two apparent hits were substrings of uuids and timestamps, checked by regex). 603 `[sealed]` placeholders present.
- The sealed store, event log, snapshots and raw webhook log contain no plaintext (grep 0).
- Filtering on a sealed field is refused by the gateway. Twenty-side search, views and workflows see only the placeholder, which is the point and also the cost.

## 5. Upgrade v2.43.0 to v2.44.0 with data

Multi stack, 2 Spaces, 603 Matter rows, a pre-upgrade `pg_dump -Fc` (1.3 MB, 0.7 s). Changed `TAG` and ran `docker compose up -d server worker`:

- Server healthy after **131 s** (the entrypoint runs `command:prod upgrade` plus cache flushes before listening). Downtime equals that.
- Log shows "Running database setup and migrations... Successfully migrated DB!", no warnings or errors. `/client-config` reports v2.44.0.
- Data identical: row count and md5 of (id, stage) per workspace schema match before and after.
- After the upgrade: the gateway read, updated and queried records, sealed placeholders held, and an inside-Twenty change still raised a signed webhook that became a `store:twenty` event.
- Not tested: skipping versions (the upgrade command chains per-version modules, V1_22 through V2_x), rollback from the dump with the old image, upgrading with a custom app installed. Only one minor step was run. Fast cadence (a release about weekly) means this repeats often.

## 6. Multiple Spaces on one Twenty

- Single mode (`IS_MULTIWORKSPACE_ENABLED=false`): a second workspace is refused ("New workspace setup is disabled").
- Multi mode: set `IS_MULTIWORKSPACE_ENABLED=true`, `SERVER_URL` and `FRONTEND_URL` to a base host, and each Space is `<subdomain>.<base>`. I used `twenty.internal` with docker network aliases `harlow.` and `northwind.` on the server. Two more settings were needed: `IS_WORKSPACE_CREATION_LIMITED_TO_SERVER_ADMINS=false` (otherwise the second workspace fails with "Workspace creation is restricted to admins"; the alternative is to create every Space as the first user), and the HTTP `Origin` header must equal the SERVER_URL origin (session cookie check) while the workspace origin goes in the `origin` argument of `getAuthTokensFromLoginToken`.
- Isolation (Harlow Legal and Northwind Bakery, one gateway and one key each): each Space lists only its own record; asking for the other's id returns "Record not found" from both gateways; Harlow's key sent to the Northwind host and asking for a Northwind id also returns not found (the key decides the workspace, not the host); each workspace has its own Postgres schema (`workspace_<base36 id>`, one `_matter` table each); a change made inside Harlow raised a webhook that reached only Harlow's gateway.
- Isolation here is application level inside one database and one DB user. A bug in Twenty crosses it; a separate database per Space does not exist in this mode.

## Decisions and next steps for the lead

1. Id format: accept "v7 layout with version nibble 4" or patch Twenty. Needs a ruling because the primitives paper says UUIDv7.
2. Spaces: one Twenty with multi-workspace (2 GiB shared) or one per Space (2 GiB each). The numbers favour one shared Twenty on a box, with the isolation caveat above.
3. Ask the spike's open items to a follow-up: narrower service role, workflow and MCP lock-out inside Twenty, sign-in after `isPasswordAuthEnabled=false`, skip-version upgrade, rollback, cursor paging in the store interface, health check that sends a test webhook.
