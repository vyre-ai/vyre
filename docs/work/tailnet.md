# tailnet

Branch: work/tailnet · Worktree: ../vyre-tailnet · Decisions: [ADR 0014](../adr/0014-tailnet.md)

## Scope

Use Tailscale fully wherever Vyre already relies on it, and wire each feature into the area it
helps. All ten parts of ADR 0014 are built. Each ships off, turns on with one switch, and changes
nothing on the tailnet itself: every ACL, nodeAttr, grant, key, Lock and Funnel step is the user's,
written out under "Steps for the user".

## Done

Round 1 (parts 1 to 6):
- Health: `link.health` (edeb4b8); Glass paces relayed viewers (e525741); Deck and Capsule show it (e0df7c1).
- Taildrop: `files.send`, `vyre send`, the box inbox (849bd4d, 03902bd, 8274e88, d3faa49).
- Taildrive: shares, audit, Mac mount, `/work` read-only in tailscaled (41ae09c, 8b75853, 0021b94).
- Tailscale SSH first in `vyre box add` and `move` (05f3ba9).
- Tailnet Lock read, onboarding card, Settings row (ff5111c, fc30220).
- Glass egress through the Mac (7f2519b, 8502ce4, 0097f64, 273b30b).

Egress fixes from the e2e run (27 Sep 2026):
- Fail closed in every case: `core/computers/egressgate.js`, a SOCKS5 gate in front of the
  sidecar that refuses (REP 0x02) unless the sidecar's tailscaled shows the Mac in use as the exit
  node; `computers.egress.status` shows its verdict as `gate`. A key that survives restarts: OAuth
  client secret or reusable ephemeral key, with `--advertise-tags=tag:vyre-egress` (62ebce3).
  Test box: 63 of 63 on
  `core/computers/egressgate.test.js core/computers/egress.test.js core/computers/computers.test.js
  core/computers/pool.test.js test/hygiene.test.js` (the gate's own file 12 of 12), and
  `docker compose -f box/compose.yml -f box/compose.egress.yml --profile computers config` passes
  with dummy values.

Round 2 (parts 7 to 10 and integration):
- One whois parser with tags and app capabilities (9ddba0f).
- Caller classes owner, guest, agent node in the names listener (526dc43); the router limits
  guests and still requires an agent node's key (7e8859e); the `network` module's guest tools (c283d47).
- Vault: `vault.relay.grants` and `vault.grants.status` (0622c88).
- Agent nodes: config (6a58845), the computer's tailnet side (e276166), join and leave in the pool
  (daf3fd7), tools (7757830), the key only to a driver-named tailnet port (020163c). Not live
  until the image change (Decisions needed 4).
- Webhooks: watchers on events with payload filters (0fa5931), the `hooks` module (7dd4a68),
  `vyre hooks` (32b3239).
- Surfaces: one Deck health helper and dots in Chat and Glass (b2af31e), Settings Network rows
  for shares, webhooks, guests, agent nodes and egress (011e0b8), onboarding HTTPS step then Lock
  (53c78d0), Capsule send on option-return and a health dot (ec1543a).
- Presence: the new owner actions on the floor's human-only list (8cb5c6d).

Tests: each branch was green on its own targeted files before merge (round 1: 258 of 258 on the
merged branch; round 2: guests 194 + 26, vault 52, agent nodes 145, hooks 66, surfaces 209 with 6
skipped).

Merged round 2, verified on the test box (27 Sep 2026, after merging main at bfbfd69 and the surfaces WIP
2fdbae9), `nice -n 15`, Node 22.23:
- The targeted run under "Doing": 803 tests, 785 pass, 12 skipped, 6 failed. One was ours
  and is fixed: the computerd tailnet "any uid but root" test used uid 1000, which is the test box's
  runner, whom the test treats as root; it now picks a uid that cannot collide (computerd: 11 of
  11). The other five fail the same way on main on the test box, so they are not this branch's (listed
  for the integrator under "Needs from others").
- Deck and fixtures (surfaces WIP): `test/fixtures.test.js deck/test/*.test.js deck/js/*.test.js`,
  35 of 35. `deck/views/settings.js` has no unit test; it passes `node --check`, and the three
  fixtures it reads parse.

Perf (scripts/perf-check on the test box, 20,016 turns, 23 modules, host load 4.4 to 5.1): CPU p95 0.00%,
sustained 0.00%, mean 0.00%; RSS mean 94 to 107 MB, max 140 to 145 MB (budget 150; main measured
147 MB max the same day); no recurring timer under 60 s. Before the fix below, the sustained CPU
check failed at 13% on this branch: one CPU-second at +1.5 s into the idle window, which a CPU
profile and a trace of Memory's pass showed to be the tail of startup curation (3.6 s on 20,000
turns) running past perf-check's 250 ms settle, not idle work. perf-check now waits for
`memory.curate`, which answers once that pass is done, before it starts the idle window.

Taildrive per-share access and the secrets scan (ea158df, 27 Sep 2026):
- Per-share access: `files.drive.shares` entries are a path or `{ path, access }` (a path is
  read-only, or the old global `files.drive.access`); status rows carry `access`; the Mac mounts
  each share by its own access. Tool `files.drive.access { name, mode }`, owner only, on
  HUMAN_ONLY, saves the access and answers the mount step.
- The compose mount stays read-only unless some share is rw; `files.drive.access` answers
  `Set VYRE_DRIVE_ACCESS=rw in /srv/vyre/.env, then run docker compose up -d` (or back to ro).
  The compose comment says so.
- A share refuses a folder with a secret anywhere inside (`unsafe_share`, `detail.found` up to
  10 paths; over 20,000 entries is too big to check); `files.drive.audit` rescans shared
  folders into `unsafe`, also in `drive.exposed`.
- Test box, `nice -n 15`, after merging main at 6e205a9: core/files/drive.test.js 21 of 21,
  core/files/files.test.js 18 of 18, core/presence/presence.test.js 22 of 22,
  test/hygiene.test.js 1 of 1, test/docs-build.test.js 31 of 31, test/fixtures.test.js 1 of 1;
  `gen-docs-reference --check` fresh.

## Doing

1 Oct 2026, the gated deploy of the three Workers (.github/workflows/relay-deploy.yml, prepared and never run): dispatch with a stage sha and which Workers; the dry run (no credentials) prints the bindings, then the `deploy` environment's reviewer approves and wrangler 4.145.0 deploys. relay/worker and names/worker deploy from the commit; relay/app needs the signed `app-out` artifact of a release run (`app_out_run`), because its build needs the release signing key, which stays in the `release` environment. Guards (reviewer-2): both jobs fail unless the workflow runs from main or work/stage-0.2 (the `deploy` environment's branch rule is to match); the sha must be on stage; `app_out_run` must be the `release` workflow's own run for that exact commit, not a pull request's, and successful, and `scripts/deploy/verify-app-out.mjs` checks every sealed folder against the pinned RELEASE_KEY (and refuses the placeholder) before anything is deployed; wrangler comes from tools/wrangler/package-lock.json with `npm ci --ignore-scripts` and the Cloudflare token exists only in the steps that deploy; checkout and setup-node are pinned by commit. The release workflow does not yet upload an `app-out` artifact, so the app step stays unusable until pwa's web export is built there. The names Worker's two runtime secrets can be set on the first deploy from the environment secrets NAMES_CF_API_TOKEN and NAMES_CF_ZONE_ID.

### Cloudflare token (for the `deploy` environment's CLOUDFLARE_API_TOKEN)
One API token, scoped to the one account and the one zone, and nothing more:
- Account, Workers Scripts: Edit (it covers the Workers, their Durable Objects and migrations, rate limiter bindings, cron triggers, observability, and the static assets of vyre-app).
- Account, Account Settings: Read (wrangler looks the account up; it is also why CLOUDFLARE_ACCOUNT_ID is set as a variable).
- Zone vyre.run, Workers Routes: Edit (the custom domains names.vyre.run and app.vyre.run; relay.vyre.run already has its).
- Zone vyre.run, DNS: Edit (a Worker custom domain creates its DNS record) and Zone: Read.
No KV, R2, D1, Queues or Workers Rate Limiting permission is needed: none is bound. The account id goes in the variable CLOUDFLARE_ACCOUNT_ID. The names Worker's own runtime token is a different, narrower one (Zone, DNS: Edit on vyre.run only), set as the Worker secret CF_API_TOKEN beside CF_ZONE_ID; it never leaves Cloudflare and no box sees it.

30 Sep 2026, own domain serves (core/names/service.js serveDomain, tool names.domain.serve, events domain.ready and domain.failed): DNS-01 through the CNAME delegation via the directory's acmeOwn, SNI on the one listener, Host and Origin rules unchanged, daily renewal. Names tests 13 of 13 including a real TLS connection on loopback. Local commit only until CI on b15748df finishes.

30 Sep 2026, Mac server: device key in core (core/relay/devicekey.js, against anywhere's f449fa0f shape), macCoreRefusal lifts everywhere with core, relay.tailnet.status available with core; relay/tailnet/keys/setup tests 73 of 73 on this Mac with a fake core (this Mac was the failing platform). Not pushed while CI runs on 3-commit tip. Next: after CI green on tailnet-02, land it, merge work/vyre-core, swap in its fakeCoreKeys and createCoreKeys at daemon boot; then bring-your-own-domain ACME DNS-01 (lead's ask).

30 Sep 2026, vyre-core phase 5, relay side (on work/tailnet-02, code to anywhere's shape, async only): `keyHandle` in core/relay/keys.js; Handshake static key as `{pub, dh}` with `readMessageAsync` (one generator, sync and async drivers); relayLink signs through `routeKey.sign`; `ctx.coreKeys` reaches the relay module only (core/modules); `macCoreRefusal(platform, core)` lifts for setup, tickets and the tailnet key paths, not relay.join or the desktop join. Tests use test/fake-core-keys.js until anywhere's `fakeCoreKeys` lands; a darwin end to end pairs a phone through core with no key file. Waiting on anywhere: the daemon must pass `coreKeys: createCoreKeys(...)` to `start()` when core is present (I did not touch daemon boot), and the sha of lib/vyre-core-keys.js. 11 tests in test/relay.test.js and core/relay/tailnet.test.js still fail on a Mac as on main (they do not fake the platform).

30 Sep 2026, reviewer-2's two changes on cc103f19 (d1e975c9 plus regenerated reference): the grant stores the claimed host and enrolls only a passkey whose rp_id equals it; relay.setup.claim is in WEB_DENY. presence and setup tests 56 of 56. Next: vyre-core phase 5 with anywhere (keys.js as a handle so macCoreRefusal can lift); asked anywhere in CHAT.md for the key-store client path and whether dh is sync.

30 Sep 2026, 0.2 build on work/tailnet-02 (plan: team/0.2/plans/tailnet.md 3.6b, 3.6c). Built, each
with tests in temp homes and fakes: link.health in the C5 shape (acf8c538); Funnel on /s/ with
consent state, ADR 0014 amended (14f4599b; event is `funnel.changed`, `artifacts.public.set` gets
`{base: null}` when off); the names directory Worker and the box's signed client, tailnet IPs only,
tombstones, no ZeroSSL (7e6a040d); the setup session: fingerprint-in-code, first-writer-wins
locators, the /v1/setup/mbx mailbox, the setup allowlist, relay.setup.begin/end/status (4dc19cc6);
relay.route.id and relay.route.sign for the names client (signs only vyre-names-v1 messages for
its own route). Next: network.tailscale.login/status/peers (plan step 4), the /hello popup page,
Wink tokens for the setup page with launch, deploy of names/worker (needs the user's OK and a
Cloudflare token), ADR number for the directory. Open: 5 core/relay/tailnet.test.js tests fail on a
Mac because they do not fake the platform; not checked against main on a runner.

28 Sep ~14:55 UTC: relay.vyre.run is LIVE. Worker vyre-relay version ac4f2172-a06a-4258-8845-aa423ef26b16,
migration v2, custom domain attached, cert valid (Let's Encrypt, to Dec 25 2026), workers.dev
subdomain "vyre-run" created (not served, workers_dev=false), Free plan. Smoke from the testbox
passed: mint and resolve, single use, full pairing, unknown ticket 404, expiry. The PAIR_LIMITER
rate limit never returned 429 (40, 90 and 80 request bursts), so I asked the lead about a zone
rule versus leaving it. ba8045cf fixes the reviewer's ADR 0046 hold (canJoin fails closed;
forget unbinds and orphan_node retries the delete), 228/228 targeted, with the reviewer. Next:
the reviewer's verdict on ba8045cf, then the lead's call on the rate limit and ADR 0046 section 4.

28 Sep ~14:35 UTC: the reviewer CLEARED d65ad771, and the lead approved the relay.vyre.run custom
domain (46900338: workers_dev=false, custom_domain route). Account checked read-only: Workers
Free, zone Free, migrations are new_sqlite_classes. The deploy FAILED at upload with Cloudflare
10063 (the account has no workers.dev subdomain, which is required even with workers_dev=false).
Nothing is live (0 scripts). Asked the lead to OK creating the subdomain "vyre-run" (free, no
billing). After that: redeploy from a scratch copy (HOME=scratch, vault env, never printed), then
smoke from the testbox (mint on a test box there, resolve with relay/client, plus the 404, 429
and expiry paths). 7588fdd6: LOW 2 (random nonce in the sealed record), LOW 1 (the ADR states
64-bit strength), identityFingerprint from lib/identity.js (kind "person"; anywhere suggested
"assistant", so I asked the lead). With the reviewer.

28 Sep 2026, after the restart (0.1.1, the user's two YESes): step 1 of 3 done, the Wink ticket
record is sealed. `core/relay/wire.js` `ticketSeal`/`ticketOpen`: AES-256-GCM under
`ticketDerive("enc")` (tag `vyre-pair-enc`, apart from loc/sec/mac), zero nonce (one record per
key), AD `"vyre-pair-record\n1"`, then the existing MAC over the sealed text. `resolveTicket()`
opens it after the MAC check; pwa's calls and the error codes are unchanged. Both relays refuse a
record that is not opaque base64url (`SEALED`). Wrote docs/adr/0045-wink.md (the file never
existed, only notes) and marked ADR 0026's Wink threat row mitigated. Swept em dashes from the
relay code comments. Testbox: 187/187 (test/relay, relay/node, relay/worker, relay/client,
core/relay, boundaries, hygiene, docs-check/build/index).

Step 2 prep done (ce15437b): dry run clean, namespace ids 26001-26003. Found relay.vyre.run has
no DNS, no route and the account has no Workers at all; asked the lead to approve a Worker custom
domain for relay.vyre.run before deploying. Nothing deployed.

Step 3 built (ADR 0046), see the ADR's "As built" section: core/relay/tailnet.js (API mint,
delete, list; desktop canJoin/joinWithKey/desktopJoin), the channel-only key path and the
internal relay.devices.bind/relay.devices.tailnet in core/relay/index.js, the tag:vyre-device
branch in core/names/identity.js plus POST /v1/tailnet/bind in core/names/service.js, the policy
grant in core/onboard/index.js, relay.join asking to join and retrying at start. Testbox: 146/146
on core/relay/tailnet.test.js (12, a real vyred plus the Node relay plus relay/client, fake API,
fake tailscale), test/relay.test.js, core/names/service+identity, core/relay/*, relay/client,
test/onboard.test.js, boundaries, hygiene, module-sdk. Not built: ADR 0046 section 4 (phones'
"Faster connection") and a desktop that stays connected and prefers the tailnet path. Never ran
a real `tailscale up` or touched a real tailnet.

Step 3 plan (ADR 0046), as it was before building:
- core/relay/tailnet.js: mintKey/deleteNode/listNodes against the Tailscale API through an
  injected fetch (seam.tailscaleApi), vault item `tailscale-mint-oauth` ({client_id,
  client_secret}); joinWithKey on the desktop (0600 file in a 0700 mkdtemp, --auth-key=file:,
  removed in finally; never joins if this machine's Tailscale is already signed in).
- Box: a pairing hello with `tailnet: "join"` (kind app only) records a join grant on the
  relay_devices row. The key comes only from an intercepted channel path, POST
  /v1/relay/tailnet/key, handled before the router (no tool), device:<id> over the relay only,
  grant required, refused on darwin, rate-capped. Answers { authKey, bindCode, address }.
- Bind: identity.js classify gains a tag:vyre-device branch. A bound node (node_id + node_tagged)
  is `device:<id>`; an unbound one reaches only POST /v1/tailnet/bind on the names listener,
  which calls module-only relay.devices.bind with whois's stableId plus the device's bind code
  (handed out only inside its Noise channel).
- Revoke: forget() deletes a tagged node through the API (best effort; admission already fails
  closed on the removed row); relay.devices.list clears a node the API no longer has (10 min cache).
- Desktop: relay.join passes tailnet:"join", persists relay-device/box.json, then fetches the key
  over a connect() channel, joins, binds; retried once at module start if not yet joined.
- onboard policy: tagOwners tag:vyre-device and one grant to the box's port, when minting is set up.

Old next line: step 2, deploy the worker once team-lead says the review cleared (dry run, migration tag
v2 for PairTicket, check the worker name relay.vyre.run routes to, numeric rate-limit
namespace_ids, smoke from the testbox only). Step 3, build ADR 0046.

28 Sep 2026, latest of all: added the owner's identity fingerprint to the ticket record (the
lead's ruling, 28 Sep): `sha256("vyre:person:v1:" + owner.id).slice(0,8)`, base64url, covered by
the same MAC as name and handle. Stubbed against `ctx.config.owner.id` until anywhere's
core/onboard lands it, a box with no `owner.id` yet returns `identity: null` in the record, never
a fabricated value; `resolveTicket()`'s result carries the same field. Tests: relay.test.js +2 (the
exact hash, and the stub-null case), 29/29 total, boundaries+hygiene 8/8. Sent to the reviewer and
pwa. Also answered federation's updated openPeer contract (dropped selfIdentity, added an
incoming-call requirement on the destination side: `module:move` caller plus `meta.peer.stableId`
from the pinned channel), not yet built, since it needs the tailnet listener's own caller
classification extended for a peer-to-peer door that isn't the owner's own device; flagged as next
work, not silently deferred.

28 Sep 2026, latest of all: built the move engine's three seams (ADR 0042, federation's
core/move/index.js). Answered their open question: `relay_devices` (ADR 0026's own Noise
identity) is the authoritative "this node is the owner's own" table, never `link_peers` (a
separate, older Mac-to-box pairing mechanism). New module-only tool `relay.devices.node`
(stableId/staticKey plus, if reported, the tailnet node via the already-built
`relay.devices.path`'s node_id/node_name, no dependency on ADR 0046 landing first). New
`core/link/peers.js`: `ownedNode`, `openPeer`, `selfIdentity`, to federation's exact signatures.
`core/link/transport.js` needed no change at all, `connector()` was already symmetric; the
Mac-to-box shape lived only in how `core/link/mac.js` always called it, never in the function
itself. `openPeer` refuses `not_reachable` honestly for a device with no reported tailnet node,
rather than guessing at an address. Tests: peers.test.js 5/5 (pure wiring, fake ctx.call), +1 on
relay.test.js, 77/77 total with boundaries+hygiene+docs. NOT run against two real daemons end to
end, said so plainly rather than claiming coverage that isn't there. Sent to federation to wire
into their own seams map.

28 Sep 2026, latest of all: ported Wink's ticket lookup to the production Cloudflare relay (the
reviewer's MEDIUM 2, the lead's priority, code and tests only, no deploy, that waits for the
user). New `PairTicket` Durable Object in relay/worker/index.js, one object per locator
(`env.TICKETS.idFromName(loc)`, not per route: a resolve request carries no route id to look one
up by). `RouteRelay`'s control socket, previously silent after auth like relay/node's, now handles
`{t:"ticket",...}` and writes to it; the Worker's top-level `fetch()` handles `POST /v1/pair`
before the WebSocket-upgrade gate, same locator-in-body/never-a-URL shape as relay/node, with
an optional per-address `PAIR_LIMITER` rate-limiting binding, charged to misses only (same optional pattern as
`DEVICE_LIMITER`; no global limit, GHSA-25xh-w9j7-7v28) and an in-memory per-route registration cap (60/minute, resets on hibernation, only weakens the cap, never the pairing security it sits in front of, which is the MAC, not this).
wrangler.toml gains the `TICKETS` binding and migration entry.

Had to extend the shared test harness, relay/worker/fake-cf.js, since it only ever bound one
Durable Object class (`ROUTES`): `createRuntime` now takes an optional `classes` map for further
bindings, each with its own isolated object registry so two bindings can never collide on the same
name; `object(name)` (used all over worker.test.js already) is unchanged for ROUTES. Two real fake
gaps found and fixed while wiring it: a DO stub's `.fetch()` needs to accept `(url, init)` as well
as a `Request`, matching the real runtime, not just the latter; `ctx.storage.deleteAll()` did not
exist at all (added, `FakeStorage`). Also one bug in my own new test, not the code under test: a
locator built as `` `f${i}`.padEnd(43,"0") `` collides between i=6 and i=60 (padding with the same
digit the index ends in is indistinguishable from more of the index), fixed with a fixed-width,
non-digit-padded index.

Tests (testbox): worker.test.js 34/34 (10 new, every one against a real Durable Object object
graph, not a stub), boundaries+hygiene 8/8. Sent to the reviewer.

28 Sep 2026, latest of all: pwa guessed a scan-to-pair contract (relay.pair.ticket.resolve then
relay.join) that doesn't exist and breaks the reviewer's two fixes; the reviewer held it and asked
for the phone-side steps published explicitly, the lead made it top priority. Published to pwa and
the reviewer: call `pairTicket()` from relay/client/client.js directly (it already does every
step, derive, resolve, verify, pair, there is no separate box tool for an unpaired phone to
call). Added `keyFingerprint(box, crypto)` to relay/client/client.js (same fingerprint format
core/relay/index.js's own Touch ID prompt shows) and a pure-JS `base32` to relay/client/bytes.js
(matched byte for byte against core/relay/wire.js's own by a new test), so a phone's own confirm
line can read identically to the box's. Documented the whole contract in relay/client/README.md,
including the relay's three resolve outcomes and why 404 deliberately doesn't distinguish
expired/used/unknown. Tests: relay/client 10/10 (1 new), relay.test.js 23/23, boundaries+hygiene
37/37, relay/worker 38/38. Sent to federation too: their move-engine design needs
core/link/transport.js's peer-verified open generalized past the Mac-to-box shape (source-
initiated, either side); acknowledged as mine, queued behind the reviewer's relay.pair.ticket
sign-off and the lead's Tailscale-carries auth-key work.

28 Sep 2026, latest of all: built relay.pair.ticket (ADR 0045, renumbered from "ADR 0037"), after the reviewer's two
blocking fixes on the design. `core/relay/wire.js` gains `TICKET_BYTES` (8), `TICKET_TTL` (5 min),
`ticketDerive(which, ticket)` and `ticketMac(ticket, record)`: every value derived from the raw
ticket under its own tag (`vyre-pair-loc`, `vyre-pair-sec`, `vyre-pair-mac`), so the relay only
ever sees a locator and a MAC-authenticated record, never the pairing secret, and can't forge or
substitute the record either (it never learns the MAC key). `relay.pair.ticket` mints via the
existing `mint()`-style machinery reused as `takeLiveSecret()` (a small map of live ticket
secrets alongside the classic single `pairing` slot, both single-use, both checked by admission);
registers `{loc, record, mac, exp}` with the relay over the already-open control socket
(`link.registerTicket`, queued if not yet connected); refuses on darwin via the renamed, shared
`macCoreRefusal` (was `relayJoinRefusal`). `relay/node/server.js` gets the relay's half: a
`pairTickets` map (single-use, swept on insert), `POST /v1/pair` (a locator in the body, never a
URL, so it never lands in an access log), rate-limited per IP and globally, and on the control
socket a handler for `{t:"ticket", ...}` after auth (previously silently ignored everything post-
auth). `relay/client/client.js` gets the phone's half: `pairTicket(ticket, o)`, which derives the
same three values, resolves, verifies the MAC itself (so a dishonest relay operator's substituted
record fails before any pairing attempt), then reuses the exact same handshake `pair()` already
ran, refactored into a shared `pairOffer()`. The lead's two additions folded in: the device's own
name at pairing is sanitised and capped exactly like the box's own name (moved `promptSafe` up so
`admit()` can use it, replacing the plain regex check); `relay.paired {device, name}` fires
alongside `device.paired`, but only for a ticket pairing, so the Deck's own scan screen doesn't
react to someone pairing a different device with the classic QR. `relay.devices.rename` already
covers the person-only rename ask (its `owner()` check is exactly that; no new tool). Gotcha that
cost the most time: a module that emits an event or registers a tool not listed in its own
module.json manifest fails to start AT ALL, silently, everywhere in the daemon (every other
module's tools still loaded; only relay showed zero tools), `does.tools` needed
`relay.pair.ticket` and `watches.emits` needed `relay.paired`, both easy to miss since nothing
about the tool/event definition itself hints at the manifest requirement. Tests (testbox): 23/23
relay.test.js (6 new: mint+resolve+redeem end to end with the real relay/client/client.js code
paired against a real vyred, not a hand-rolled test double; the device's own name sanitised;
the relay never learns the secret and a tampered record fails the MAC; the darwin refusal; a
rate-limit check), 78/78 boundaries+hygiene+docs-build+docs-index+modules, 38/38
relay/worker/worker.test.js (untouched, still green), 24/24 relay/client's own unit tests, 7/7
relay/node/server.test.js. Regenerated docs/reference/*. Sent to the reviewer.

28 Sep 2026, later still: binding user decision, relay-first everywhere ("Wink" in copy, same
mechanism as the scan-to-pair note below, renamed). Servers skip Tailscale too by default.
Claimed ADR 0046 (renumbered from "ADR 0038"; docs/work/README.md is stale, <team-dir>/ADR-NUMBERS.md is the live registry), amends ADR 0002 and ADR 0014. Design note sent to the
reviewer (copy to the lead), not building: the caller-classification layer needs nothing new
(`ownerDevice()` in core/modules/index.js already treats `device:<id>` and `tailnet:<owner>` as
equal, built for ADR 0026); the tailnet listener (core/names/service.js, `tailscale whois`)
simply doesn't start when there's no tailnet. Proposed `<handle>.vyre.run` become an alias to
`app.vyre.run` rather than building a new TLS-tunnel/TCP-proxy component, reuses ADR 0026 sec
10's already-shipped static-shell-plus-Noise-channel design, no new infra. Listed what has no
relay equivalent today (Taildrive, Taildrop, checked, `core/files/drop.js` calls the real
`tailscale file cp`, not transport-agnostic, agent-node egress/computers.tailnet, guests from
another tailnet, Tailscale SSH for box admin) and flagged the relay's own uptime becoming the
box's uptime for a no-tailnet box, which ADR 0026 sized as an optional secondary path, not
required infra. Waiting on the reviewer and the lead before writing anything. Idle otherwise.

28 Sep 2026, new from the lead: scan-to-pair (phone.vyre.run scans the owner's avatar / Vyre
code, no Tailscale on the phone). My part is the relay side: `relay.pair.ticket` mints a short
ticket, registered with the relay so a phone can resolve it to the box's signed identity, then
runs the ordinary pairing handshake. Claimed ADR 0045 (renumbered from "ADR 0037"; docs/work/README.md is stale, team/ADR-NUMBERS.md is the live registry), amends ADR 0026
section 6. Design note sent to the reviewer before writing any code: a 64-bit ticket (stored only
as its hash, 5 min TTL, single-use, reusing the existing pairing mint()/secret-hash machinery
unchanged); a new relay HTTP resolve endpoint (both relay/node/server.js and relay/worker/) that
answers a record signed with the box's existing route.key (self-certifying, so the relay's own
word is never trusted for identity); the one real amendment flagged for sign-off is that box.key's
*public* half now reaches the relay, which ADR 0026 currently says never happens; and an open
question on whether Touch ID gates only the mint (today's relay.pair.start shape) or also the
redeem (new pending-confirm machinery, not built anywhere in this repo yet), recommended the
former, deferred to the reviewer and the lead. Not building until that lands. Idle otherwise.

28 Sep 2026, still later, two items from the lead: relay.join refuses on darwin, and the host
sanitised the same way as the name. `relayJoinRefusal(platform)` (exported, a pure function of an
explicit platform like installCommand/operator in core/names/tailscale.js) refuses with
`not_available_here` on darwin: redeeming a pairing code persists this device's own identity key
(relay-device/key.json, core/relay/redeem.js) at the person's login uid, the same gap that already
keeps relay hosting off by default on local role until vyre-core (ADR 0040) holds the box's own
relay key instead. Wired into relay.join's run() (refuses first, before owner()) and into
presence.when (no Touch ID prompt on darwin: the call can only fail). Host sanitisation: pulled
the name's existing strip-and-cap into a shared `promptSafe` helper, widened the stripped set to
Unicode format and bidi characters (zero-width, RTL/LTR override and embedding, BOM, none of
which parsePairUrl's own check on `relay` bars, since it only refuses whitespace and a slash) and
applied it to the relay host too, capped at 64 (hosts run longer than names). Tests (testbox):
relay.test.js 18/18 (2 new: relayJoinRefusal direct plus an end-to-end darwin run via
Object.defineProperty(process, "platform", ...) before starting a fresh daemon, the module reads
platform once at its own start(), so the flip has to happen first, not after; and the hostile-host
case folded into the existing hostile-name prompt test), boundaries+hygiene 8/8, docs-build+
docs-index 37/37 (the description change moved docs/reference/tools.md; regenerated with
npm run docs:ref and the committed-index test still passes). Sent to the reviewer.

28 Sep 2026, right after: reviewer SIGNED OFF 7f9bc201, one nit, promptSafe's stripped set was
missing two separator characters that are neither a C0/C1 control nor in the zero-width/bidi
blocks: the Arabic letter mark (U+061C) and the Mongolian vowel separator (U+180E). Added both
(86e491ba), extended the hostile-host test to cover them. Testbox: relay.test.js 18/18. Idle.

28 Sep 2026, latest of all: reviewer signed off ad8f560c/98ddb0a8/0a77983c/6cd9c02d (relay.join,
in full). Reviewed anywhere's onboard guard (work/anywhere 6300ecaf) properly, found a real bug of
my own while doing it: onboard.machine's shipped input is `{machine}`, no "action" field, but their
own design doc still says `{action:"set", machine}`, both my becomeDevice call sites were built
against the doc, fixed to match the code (b23036af), flagged the doc drift to anywhere. Fixed
reviewer's LOW on relay.join's prompt too (97a17392): offer.name (the OTHER box's own chosen text)
is stripped of control characters/newlines and capped at 40 characters before it's quoted, and the
trailing key fingerprint is always computed here from the real key, never from the name, a
hostile box can no longer write a fake "(key ...)" trailer into its own pairing offer. Sent
anywhere a coordination note: if they narrow onboard.machine's callers off bare "module", they
need to include module:relay specifically, or relay.join's becomeDevice breaks silently (my
ctx.call(...).catch(()=>{}) swallows the resulting error). launch has wired both paths
(relay.join{url,becomeDevice} and onboard.join{verify,node,becomeDevice}) on fixtures, waiting on
both to land on main. Testbox: 51/51.

28 Sep 2026, latest still: fixed reviewer's MEDIUM on relay.join before the stay-connected
follow-up (6cd9c02d). The Touch ID prompt was generic ("Pair this device with another Vyre");
now it parses the URL and names the actual box, its relay host, and a short key fingerprint
(base32 of sha256 of the box's public key, 8 chars as two groups of 4), so a phishing message's
pairing link can't blend in as "just pairing", and a url that fails to parse gets an honest
summary instead of a silent generic fallback. Refuses before any prompt at the schema layer
(checkInput runs before presence.required) for anything not shaped like a pairing link, and again
in run() via parsePairUrl for a well-formed-looking but corrupt fragment. Testbox: 54/54.

Standing by per the lead: review anywhere's shared onboarding-on-Mac check (setup tools refused on
a Mac unless Solo genuinely needs one, 127.0.0.1:7300 only on a server) when it lands, that's
reviewer's condition 2, still open, and not mine to build a second version of. Idle otherwise.

28 Sep 2026, latest: two more items from the lead. First, extracted relay's key access into
`core/relay/keys.js` (3ab44de2), loadKeys(root) unchanged in behavior, just its own file, so
moving where the box's Noise/route keys live (vyre-core's `_vyre` service user, ADR 0040) is a
swap of this one file, never a rewrite of relay's pairing logic. Second, and bigger: built
`relay.join` (93754fa2), the redemption side reviewer wanted to see, a fresh Vyre install
becoming a device of another box, over the relay, with a one-time pairing code. New
`relay/client/nodecrypto.js`: a Node-native CryptoProvider for `relay/client/*` (the SAME
cross-platform library the Expo app uses, so this is not a second protocol implementation), since
Node's own `globalThis.crypto.subtle` makes non-extractable keys that cannot survive a CLI's next
process, and `@noble` is the Expo app's own dependency, never this repo's. New `core/relay/redeem.js`
(a plain function) and the tool `relay.join`: takes a pairing URL, runs the handshake, persists this
device's key so its identity survives a restart, refuses guest/agent/hook/anonymous the same as
relay's own owner(). Does not keep a connection open afterward, that is `connect()`'s job, not
built yet. Tested end to end: two real daemons, a real local relay server, the box mints a code
with `relay.pair.first`, the device redeems it with `relay.join`, the box's own device list shows
it, a second redemption from the same root reuses the same device id. Testbox: 59/59.

28 Sep 2026, still later still: reviewer OK'd the Solo-join shape with 4 conditions; anywhere OK'd
widening relay's roles (theirs is landing onboard's own roles change separately). Built (2a02f4d8):
relay/module.json roles -> `["box","local"]`, no code change (audited start(): startLink() only
fires when settings().enabled, default false; no timers anywhere in the module); new
test/relay.test.js proving it, boots role local with default config, zero relay.connected/
disconnected events, no injected WebSocket seam (so it is the real globalThis.WebSocket path
proven untouched). onboard.join's tailscale-connect step now calls `tailscaleUp()` directly
instead of `ctx.call("names.connect")`, dropping the box-only `names` module as a dependency for
that path; onboard.tailscale itself unchanged.

**Not shipping**: relay-on-a-Mac stays built-but-disabled until vyre-core (ADR 0040, e2e +
anywhere) holds relay's pairing secret and trusted-device rows. Today those sit in
`~/.vyre/vyre.db`, readable and writable by any process at the person's uid, a prompt-injected
model could read a live pairing secret or insert its own device row for lasting access. Reviewer's
condition 3, and already on vyre-core's list. Do not enable relay by default on local role in any
release before that lands.

**Open**: reviewer's condition 2 (audit onboard's start() for local-role side effects beyond the
9 wizard tools) is on hold, asked anywhere whether their own onboard roles change keeps my
"guard the 9 wizard tools" idea, since their Solo-onboarding design might legitimately want those
tools live on local by intent, which would make my assumption wrong. Waiting before writing a test
that could assert the wrong thing. Settled with launch (not yet confirmed back by them): "I already
have a server" splits into a no-code Tailscale path (`onboard.join{tailscale,connect}` then
`{verify,becomeDevice:true}`) and a relay path whose code is minted by `onboard.join{action:"relay"}`
but redeemed by `relay/client/*`, not by any join.* action.

28 Sep 2026, still later: reviewer signed off bac69fa8 (owner-only onboard.join, confirmed by
merging in e2e-personguard c3a69611 via origin/main and running test/person-only-guard.test.js, onboard.join's callers list derives PERSON_ONLY automatically). Root-caused (not just flagged)
the testbox onboard.test.js failure I'd been calling "pre-existing": bundled this branch, checked
out ecd89c0c (the commit that introduced the failing test, well before anything in today's
session) on testbox, ran it alone, failed there too, proving it was never caused by join work.
Cause: operator() (core/names/tailscale.js) skips its check entirely on darwin, so a missing
OperatorUser field in the test's fake tailscale script passed by accident on every Mac and failed
for real on testbox's Linux, the only place the check runs. Fixed (dd1c3765); test/onboard.test.js
is 23/23 on testbox now. All testing from here on is testbox only, per the lead.

Answered launch's shape question: "I already have a server" splits into two paths that don't
share a mechanism, Tailscale (no code: `onboard.join{tailscale,connect}` then
`{verify,node,becomeDevice:true}`, needs nothing new) and relay (the code IS a pairing secret, but
minted server-side by `onboard.join{action:"relay"}` and redeemed by the relay CLIENT protocol,
`relay/client/*`, not a join.* action, and not mine to build).

Sent e2e a question on the Solo-join design before continuing: the lead flagged that pairing/relay
keys move into vyre-core (a new `_vyre` service user, ADR 0040, e2e + anywhere) on a Mac, and
wants the join design to go through that boundary. Waiting on ADR 0040's shape (or e2e's direct
answer) before writing the relay/onboard "local" role code my design note (sent to reviewer and
anywhere, still unanswered) proposed.

28 Sep 2026, later still: built `onboard.join` as `core/join` (the lead: "stop waiting, build it").
join.status/join.tailscale/join.relay/join.verify, box role, all thin forwards through ctx.call
to onboard/relay/link's own tested tools (see "Changed contracts"). Works today for pairing a
second device to a box, and for a moved installation pointing back at its server. Does NOT yet
cover the lead's other example, a phone joining a Solo Mac: role "local" has neither onboard nor
relay loaded (both `roles: ["box"]`), so there is nothing for `join` to forward to there. That is
not mine to fix alone, flagged below. Sent af604cf8 to reviewer. Answered launch: Solo needs
nothing from this module (confirmed), names.discover is unaffected by anything here (it scans
peers and hits the already-shipped GET /v1/whoami itself, a client-side tool still to build, not
a change to /v1/whoami).

Same day, right after: launch asked for one tool with an action/step param instead of four (to
match onboard.name/claude/tailscale's own shape), and anywhere OK'd the design and asked verify to
call their new `onboard.machine` once reachability is confirmed (ADR 0039 section 5, contract in
their docs/design/anywhere.md; not yet on this branch). Dropped `core/join` entirely (5807096d);
`onboard.join` now lives in core/onboard/index.js, one tool, reusing onboard.tailscale's own
functions directly (no self-ctx.call) for the tailscale action. `becomeDevice` is an explicit
opt-in flag on verify, defaulting false, my call, not yet confirmed by anywhere/launch: verify
runs on both the connecting device and (potentially) the solo/server side checking a peer, and
only the connecting side should ever demote itself to "device". Tests: test/onboard.test.js
22/22 (6 new). No regressions: boundaries/hygiene/module-sdk/modules 48/48 (this Mac only, testbox is frozen for the integrator's rc.2 canonical suite; will sync and run there once it
lifts). The box-role-only gap (a phone joining a Solo Mac) is unchanged by this refactor; still
flagged below and to relay/anywhere/launch.

28 Sep 2026, later: new top priority from the user's "Vyre anywhere" decision (see
team/HANDOFF.md), Tailscale is not needed for Solo; it comes in only when a second device or a
server joins. My part: the "join" flow (guide Tailscale setup or offer the relay alternative,
pair, verify reachability), simple, one-paste policy tool, never `tailscale up` or an ACL edit
myself. Committed prior WIP first: core/vitals module (0.1.0, five tools, person-only, 33/33
tests), 6a52ad23. Proposed the join interface to anywhere, launch and federation (not yet built,
awaiting their OK): a new box tool `onboard.join` (HUMAN_ONLY), separate from the first-run
wizard, `status` (tailscale + relay availability), `tailscale` with `step: policy|connect|lock`
(delegates to today's onboard.tailscale logic), `relay` (delegates to relay.pair.start),
`verify` (link.health, answers reachability + which path). Waiting on their answers before
building `onboard.join` itself.

Built meanwhile, the join flow's lowest primitive: `GET /v1/whoami` on the tailnet listener
(core/names/service.js), for a device that thinks it just reached the box over Tailscale (or,
later, the relay) to confirm it as owner or guest before the join UI goes further. Minimal by
design: `{ kind, name }`, name only for the owner, never a login/tag/cap (those already reach the
router via callerOf/peer for tools that need them). Refuses an agent's node outright (`403`, a
computer has no join flow of its own) and rate-limits at 10/minute per node/stableId (`429`), since
it needs no proof beyond whois. Tests: core/names/service.test.js 18/18 (4 new), plus
test/boundaries.test.js, test/hygiene.test.js, test/guests.test.js, test/link-federation.test.js
24/24 (no regressions). Next: wire `onboard.join.verify` (once agreed) to call it for the joining
device's own reachability check, not just the box's.

Also built: `vyre vitals` (status/explain/advice), vitals' first CLI surface (module.json
`shows.cli` was empty). core/cli/commands/vitals.js on the standard pattern; tips now point at it
instead of `vyre call`. Tests: core/cli/commands/vitals.test.js 2/2, consistency 9/9. Testbox
83/83 across vitals, the new test, consistency, docs-build, hygiene, boundaries (a3f73860).

28 Sep 2026 (resumed; merged origin/main a3a844e4 into work/tailnet, clean). Wrote
docs/design/tailscale-plan.md for the lead's max-benefit/simplest-install ask: verified all ten
ADR 0014 parts by content against origin/main (nine are ancestors of main; part 9, agent nodes,
is not wired, core/computers/image/Dockerfile still runs everything as `USER agent`, no
root-then-setpriv step). Lead's decisions back: part 9 ships in 0.1.1 on top of glass-live's
root-then-setpriv image change once that merges (messaged glass to coordinate: my side, join()
in core/computers/tailnet.js, already degrades safely on a 404 and needs only the real port
number/how the root process starts once their image lands); the merged-policy-snippet tool ships
0.1.1 (with launch, in onboarding); device posture is skipped. Built: `onboard.tailscale
{ action: "policy" }` in core/onboard/index.js, merges Taildrive's nodeAttrs/grant, Taildrop's
grant and the SSH rule into one paste using real names this machine already knows (its own
tailnet node, the paired Mac from `link.peers`, the owner's login, the shares from
`files.drive.status`), adding egress's tagOwners/grant only while `computers.egress.status` says
it is on. Read-only, no tailnet write (ADR 0014 rule 1). Tests (targeted, this session):
test/onboard.test.js 17/17 (2 new), test/boundaries.test.js 5/5 (no new import: uses ctx.call,
not a direct import of files/drive.js or computers/index.js), test/hygiene.test.js +
test/docs-build.test.js 39/39. MagicDNS surfacing (the other 0.1.1 item) is already done, `t.node.dns` is the primary line in both deck/onboard/onboard.js:430 and
deck/views/settings.js:277, and `vyre box add` already prefers a peer's dnsName
(core/cli/commands/box.js:273), nothing to build there. Next: message launch about wiring
`onboard.tailscale{action:"policy"}` into the onboarding UI (a "copy policy" panel, likely near
the tailscale step or in Settings, Network); wait on glass for part 9's port number.

27 Sep 2026 (resumed after logout 3, main ef51363 merged at 7036361). Done this session:

- 1498c4a VyreDrive: users see the box shares as "VyreDrive (built on Tailscale's Taildrive)"
  (tool descriptions, refusals, the Deck row, compose comment, docs; the anchor is now
  `#vyredrive-the-box-folders-on-your-mac`). "Taildrive" stays only where it names Tailscale's
  mechanism (drive:share, drive:access, tailscale.com/cap/drive, their docs link, "in alpha").
  The share scan skips real node_modules, dist, .next, target, venv, .venv and .git/objects (not
  counted toward SCAN_LIMIT) and flags a .git/config with a URL carrying user:pass or a token
  before the host, or an extraheader with Authorization (an ssh URL with only a login name is not
  a finding). files.drive.access moved HUMAN_ONLY to PERSON_ONLY. GUEST_SAFE is glass.close and
  threads.list (glass.open dropped).
- 387c671 CORS for the hosted app (`network.origins`, default `https://app.vyre.run`, exact
  match) on the tailnet listener: owner only (a guest or agent node gets a plain 403 with no CORS
  headers), preflight GET/POST with content-type, authorization, x-vyre-session, max-age 600, no
  credentials, `Access-Control-Allow-Private-Network` when asked. `GET /v1/health` from the app
  answers `{ reachable: true }` without vyred (the tailnet probe). Every other call and WebSocket
  needs `deps.webSession(req, who)` (e2e fills it; none wired yet, so all refused with 401
  `web_session_required`); the router gets `peer.origin` and `peer.webSession`.
- 32cef89 (+ f094246) projectsDir: a box with /work and no projectsDir set uses /work/projects;
  the first start moves homes from ~/Vyre/projects once (EXDEV copy across volumes), leaves a
  link at each old folder (Claude transcripts are keyed by path), rewrites rows and markers,
  records projects-moved.json and emits projects.moved. Docs updated.

Tests (test box, `nice -n 15`): the subagent's runs 241 of 242 (1 skipped) and 67 of 67 over
drive, files, presence, guests, identity, hygiene, docs-build, fixtures, presence-bypass,
presence-cli, harness, capsule launcher, deck/test, docs-check, docs-index, computers, glass,
move; then 100 of 100 (service, identity, guests, onboard, hygiene, docs-build, config, move) and
106 of 106 (projects, config, drive, docs-build, docs-check, docs-index, hygiene). A mutation
check (owner and session rules removed) fails the CORS test. No perf change expected (no timers,
one header check per request); perf-check not rerun.

Phone path, tailscale#19147 (researched 27 Sep, no device): OPEN since 2026-03-27, iOS 26.4.x.
Safari/Chrome show ERR_SSL_PROTOCOL_ERROR or "server not found" on *.ts.net while the 100.x
address works. Not TLS: a DoH app or encrypted-DNS profile (DNSecure, NextDNS, Control D)
overrides Tailscale's split resolver on iOS, so the name resolves publicly (to Funnel ingress when
Funnel is on, hence the TLS-looking error) or not at all. Private Relay and Limit IP Tracking are
not the cause. Related open iOS issues: #18889 and #19504 (tunnel drops every few minutes on iOS
26.4, app 1.94 to 1.96.5), #13799 (On Demand does not trigger for ts.net names). Nothing on the Mac
or in the Simulator can reproduce it (they use macOS's stack); only the server side can be
checked (`openssl s_client ... -alpn h2,http/1.1`, `dig +short <box>.ts.net @1.1.1.1` must be
empty). Risk: medium-high as the only phone path. Mitigations: keep Funnel off on the box (clean
"not found" instead of a fake TLS error); the hosted app at app.vyre.run probes
`https://<box>/v1/health` (built, above) and falls back to the relay, with help text naming the
cause (Tailscale off, a DNS app, toggle Tailscale); a service worker on the ts.net origin shows a
cached help page. Recommendation to the lead and app-design: relay as the always-works path and
the tailnet as an automatic upgrade when the probe answers. The docs row is in
docs/using/tailscale.md "When a device cannot connect".

Later the same day (lead and e2e answers):
- 1afde745 e2e's contract: CORS headers are content-type, authorization, x-vyre-proof (not
  x-vyre-session, the socket's thread header). The listener no longer checks sessions: it passes
  `req` untouched with `peer.origin`; the router (core/daemon/index.js route()) refuses any
  cross-origin call without a person session, `401 person_session_required`, except
  `POST /v1/person/token`. The seam is `core/presence/person.js` `personSessions(db).sessionOf`
  (a stub that finds none; e2e wires it; `start({ person })` injects one in tests). WebSockets
  from the hosted origin pass for the owner (tickets already need the session). GUEST_SAFE is
  threads.list only. `projects.move` is PERSON_ONLY. Test box: 285 tests, 284 pass, 1 skipped.
- 75d21113 projects: no automatic move. A new box uses /work/projects; an existing one keeps
  ~/Vyre/projects until `projects.move` (`vyre projects move --dry-run` first). The real move
  needs VYRE_PROJECTS_MOVE=1 or config projects.move "enabled": box-deploy validates it on a
  copy of the live box first.
- Lead decisions: a login-only ssh remote is not a secret; relay is the always-works phone path
  and the tailnet an automatic upgrade when the probe answers.

- 7cd25e6c: e2e built the gate in the router themselves (work/e2e 8ad92a73, fb097a3d), so my
  stub core/presence/person.js and my route() gate are removed; the listener only sets
  peer.origin and passes req untouched. Trial merge with work/e2e conflicts only in generated
  docs, CHANGELOG, core/presence/index.js (PERSON_ONLY: take both lists) and
  test/guests.test.js (take mine: guests have threads.list only). NOT yet tested: the test box is
  frozen for the integrator's suite. Queued run: core/names/service.test.js test/guests.test.js
  test/daemon.test.js core/presence/presence.test.js test/hygiene.test.js test/docs-build.test.js.

- Relay (27 Sep): the only origin is https://app.vyre.run (no previews). The relay path needs no
  CORS (one WebSocket to relay.vyre.run, requests rebuilt in-process by bridge.js with caller
  device:<id> and no Origin), so this CORS serves only the direct tailnet path. Its allowed
  headers now match the relay's: content-type, authorization, x-vyre-proof, x-vyre-presence,
  idempotency-key, last-event-id.

- After the freeze (test box, `nice -n 15`, load 4.5): names service, identity, guests, onboard,
  daemon, presence, presence-bypass, projects, config, hygiene, docs-build, docs-index, fixtures:
  179 tests, 178 pass. The one failure was my hosted-app test asserting e2e's 401, which lives on
  work/e2e; it now asserts only the listener's part (guests 9 of 9).

- Final state (27 Sep, stop point): work/tailnet a7365a99 (main merged at e785f124, system.info
  answers network.origins for pwa's Hosted app row; test box 154 of 154). work/federation
  334270d1 on top of 06441c6f: Mac-owned asks answered from the box, an owner device needs the
  person session, gated asks need a fresh proof, the Mac rechecks (test box 252 of 252). Both
  pushed and queued for merge batch 4 (after 3a). The Mac-owned session default stays HELD until
  e2e's person session is live on the box. Follow-ups sent, each pointing at
  docs/work/federation.md "Needs from others": chat (Deck buttons in place of "Answer it on
  <mac>"), pwa (push for a Mac ask opens /needs/<ask>, which the box cannot load), sessions
  (review the switchboard hunks; threads.asks on the box does not list open Mac asks). Side
  effect for sessions: on a box /v1/tools lists threads.answer with presence: true.
- Sessions reviewed 06441c6f and 334270d1: fine, applies cleanly after batch 3a. Sessions
  DECIDED: threads.asks on the box merges the Macs' open asks (add "threads.asks" to ALLOW in
  core/link/allow.js, rows labelled source:"mac" and machine via mergeRows, as threads.list does
  in core/switchboard/index.js). Built: work/federation 98048454 (test box 117 of 117), sent to the integrator for batch 4. Chat's Deck side is
  work/chat b524397 (untested; told them no flag is needed and that a passkey proof is not a
  person session).
- Next for whoever resumes: box-deploy's validation of `projects.move` on a copy; the "Verify on
  first real run" list below; the egress authenticating front (Next 4).

Waiting: e2e (merges work/tailnet and tests the app flow end to end), relay (origin list, and whether the
hosted app ever reaches the box through the relay), sessions (threads.answer contract for
Mac-owned sessions, below).

## Next

Order (lead, 27 Sep 2026): the WebSocket upgrade handler (above), then the Mac-session send
path's loose ends (below), then Taildrive.

- Mac-session send, loose ends (work/federation):
  - Fix the phone /find page: no machine chip on Mac rows (lead's item 3).
  - Chat asks that the Mac's rows in threads.list and projects.catalog carry `source: "mac"`,
    as main does. Check the labels survive on the paths chat reads, then send chat the frozen sha.
  - ADR 0021: record v2 of threads.answer on a Mac session. The box verifies presence, then
    sends a signed assertion from the paired box, which the Mac accepts for threads.answer
    only. v1 ships the Deck line "Answer it on <mac>" (lead's decision).
  - capsule-now has not answered the queue-flow review yet.
  - projects.list does not count a picked Mac session in a project's thread count (Chat shows
    "1 session" where the board has 2).

The lead's earlier decisions of 27 Sep 2026, still to build in this order:

1. Done: **link.health on the box: modules and the owner only.** `core/link/box.js` refuses
   guests, agent nodes, agents at the box, MCP, anonymous callers and any tailnet login that is not
   `network.owner`; test in test/link.test.js. Tests on the test box: link, link-federation,
   guests, health, glass, hygiene 33/33.
2. **Taildrive:** done (projectsDir move 32cef89, under "Doing"). Verify on the first real
   box start: the move across the vyre-home and vyre-work volumes, and Claude resuming a
   session through the old-path link.

0. **Done on work/federation 06441c6f (see docs/work/federation.md). Federation, threads.answer for Mac-owned sessions** (ADR 0030 step 7, ADR 0021 v2),
   proposed to sessions 27 Sep: the box checks a person caller, then forwards over the link with
   an Ed25519 assertion { v, tool, mac, thread, ask, decision sha256, caller, device, iat, exp
   +60 s, nonce } signed by a box link key the Mac pins at pairing (TOFU once for paired Macs).
   The Mac accepts it for threads.answer on that ask only, once. Build on work/federation after
   sessions confirms the ask id, the input shape, the already-answered outcome, and source:"mac"
   on relayed ask events.
3. **Taildrop:** the box stays a tagged server. The user step is the file-sharing grant to the
   box's tag (already under "Steps for the user"). Drop the "sign in as the owner" alternative.
4. **Egress:**
   - Done: renew with a Tailscale OAuth client (`--advertise-tags=tag:vyre-egress` is set), and
     the gate that fails closed when the Mac stops offering its exit node. The authenticating
     front below can live in the same gate (`egressgate.js`) rather than a new service.
   - Only the computer that has egress turned on may use the proxy. Per-computer credentials,
     handed out like the other bootstrap secrets (not in container Env), plus a network policy
     if compose allows.
   - Known limit to report: tailscaled's SOCKS5 server has no authentication, and Chrome sends no
     SOCKS5 credentials. So the plan is a small authenticating front (an HTTP CONNECT proxy with
     per-computer Basic credentials) in front of the sidecar's SOCKS5, answered through
     hands-chrome's CDP (`Fetch.authRequired`), plus a source-address allowlist of
     egress-enabled computers kept by the pool.
   - Inside one computer, any process of the agent's user can still use that computer's
     credential, because it owns Chrome's process. The lock is per computer, not per program.
     Tell the lead before building if that limit is not acceptable.
5. **Part 9's image change** (tini as root, a root-only tailnet side on 7001 with its own token,
   `setpriv` down to uid 1000): waiting on the user; see Decisions needed.

### Verify on first real run

The lead runs these once the user signs the box into Tailscale during onboarding. Until then,
only read-only checks on the test box.

- **Taildrive:**
  - tailscaled serves a share as the `vyre` user.
  - `mount_webdav` works against 100.100.100.100:8080.
  - The shape of `tailscale.com/cap/drive` in whois `CapMap`.
  - The WebDAV path's tailnet segment.
- **Taildrop:** the `file get --verbose` line format on 1.102, `TaildropTarget` for the tagged
  box, and the file-sharing grant's exact form.
- **Health:** the peer-relay `ping` line.
- **Egress:** containerboot with `read_only` and `cap_drop: ALL`, in-memory state, an OAuth
  client secret as the key (with `--advertise-tags`), Chrome with a `data:` PAC over SOCKS5 (the
  computer image's Chromium, never headless-shell), and `docker compose config` on both files.
  The gate on a real tailnet:
  - containerboot puts the socket at `TS_SOCKET` in the `egress-sock` volume, and uid 1000 in
    the gate can open it through the read-only mount (tailscaled makes it 0666; a status read
    needs no operator).
  - The status fields: `BackendState`, `Peer[*].ExitNode`, `ExitNodeOption`, `Online`,
    `ExitNodeStatus.Online`, in each of the e2e cases: Mac serving (allowed, bytes on the Mac's
    tailscale0), Mac stops offering, route unapproved, Mac off the tailnet (all REP 0x02, the
    gate's log says why, `computers.egress.status` shows it).
  - The recovery: offering again is allowed within 2 s, with no restart.
  - A sidecar restart with an OAuth client secret and with a reusable key comes back; the gate
    refuses while it is down.
  - A long-lived connection when the Mac stops offering mid-way: expected to break, not to move
    to a direct route, since the flow lives in tailscaled's netstack. Unverified.
- **Grants:** a `vyre.run/cap/vault` or `vyre.run/cap/guest` grant appears in whois `CapMap`,
  including for a shared-in node from another tailnet.
- **Funnel:**
  - The flags `--bg --https=8443 --set-path=...` and `off`.
  - The `funnel status --json` fields.
  - The proxy strips the mount path.
  - Node attributes show in `Self.CapMap`.
- **Agent nodes** (after the image change): a computer joins as `tag:vyre-agent`, and whois maps
  it to its agent.
- **Tailscale SSH:** `vyre box add` to a host with Tailscale SSH on, including check mode.

## Needs from others

- OWED to federation: `core/link/transport.js`'s `connector()` is parameterized (`verify`,
  `pinned`) but every caller today assumes the Mac-is-client/box-is-server shape. The move engine
  (docs/adr/0041-move-engine.md) needs the same peer-verified open symmetrically, either side,
  source-initiated. Mine to build; queued behind the reviewer's relay.pair.ticket sign-off and the
  lead's Tailscale-carries auth-key work.

- RELEASE BLOCKER, all teams: relay's pairing secret and trusted-device rows live in
  `~/.vyre/vyre.db` on a Mac today, readable and writable by any process at the person's uid.
  Widened relay to role "local" (2a02f4d8) for the Solo-join design, but it must not ship enabled
  on local by default in any release until vyre-core (ADR 0040, e2e + anywhere) holds those keys
  and secrets. Reviewer's condition, already on vyre-core's list.
- anywhere: waiting on whether onboard's own roles:["box","local"] change (landing separately)
  keeps the 9 wizard tools (you/claude/name/history/skip/finish/passkey/link/tailscale) guarded to
  refuse on local, or intentionally leaves them live for Solo's own onboarding, settles whether
  reviewer's condition 2 (audit onboard's start() for local-role side effects) is mine to close.
- launch: RESOLVED, now that relay.join exists, sent the final shape: the Device card's setup
  code is `relay.join{url, name, becomeDevice:true}` (one call, no separate verify: pairing itself
  proves reachability); the Tailscale route is unchanged, `onboard.join{tailscale,connect}` then
  `{verify,node,becomeDevice:true}`. Waiting on launch to confirm they've wired one or both.
- launch: names.discover (peer scan + GET /v1/whoami, already shipped a20e5eb6) is still to build,
  on the client side that does the scanning; not blocked on anything of mine.
- chat (via the lead): merge work/tailnet (owner-only streams) and work/federation-transcript
  6731af9 (rich Mac transcripts; then boot a Mac session from `recall.transcript { source: "mac" }`
  in deck/chat/session.js).
- integrator: merge work/tailnet (this branch's tip) and work/federation 5c247ce.
- e2e: re-run the egress checks on headscale (the list under "Verify on first real run").
- e2e: merge work/tailnet and run the hosted-app flow end to end.
- box-deploy: validate `projects.move` on a copy of the live box (dry run, then the real move
  with VYRE_PROJECTS_MOVE=1, then a Claude session resuming through an old-path link).
- relay: the hosted app's origin list (preview origins?) and whether it ever reaches the box
  through the relay (then CORS must be answered there too).
- chat: replace "Answer it on <mac>" with normal buttons calling threads.answer with `machine` (work/federation 06441c6f, federation.md Needs from others).

- vault: see the tailnet entry in docs/work/vault.md "Needs from others".
- computers: review the Pacer (`glass.js`), the pool's egress remake and agent-node join, the
  `stable_id`/`node`/`egress` columns, and `entrypoint.sh`'s PAC check. Part 9 needs the image
  change in Decisions needed 4, which amends ADR 0009.
- watchers: review the new `on`/`where` event trigger and the `hook.delivery` hand-over.
- capsule: repackage to pick up option-return send, the dot and the Taildrive open.
- box: review the `/work` mount in the tailscale service and `box/compose.egress.yml`.
- integrator: the full suite on the merge. Five tests fail on main on the test box as well as here, so
  they are environment or main issues, not this branch's: `box add: sudo with a password adds the
  account to the docker group...` (core/cli/commands/box.test.js:300; the test box's user is already in
  the docker group), `install-box.sh: missing Docker is offered...` and `...without --yes and no
  terminal...` (core/names/system.test.js:279, 286; the test box has Docker), `daemon: the presence
  challenge route refuses what it cannot start` (test/daemon.test.js:320, 403 not 400), and
  `bypass: a Bash tool call that tries it is denied...` (test/presence-bypass.test.js:129, Node
  22's SQLite ExperimentalWarning lands in the JSON it parses).

## Standing rules (user, 27 Sep 2026)

- Vyre does not nag: the user runs on bypass permissions. Nothing the person, their own sessions
  or their assistant do to their own things prompts or asks for Touch ID. Agents add notes,
  reminders and todos freely.
- Touch ID only for pairing a new device, vault secrets, and sending, posting or paying to the
  outside world. One Touch ID covers about 30 minutes per device.
- Agents stay silently refused on person-only tools.

## Decisions needed from the user

1. Decided (lead, 27 Sep): Taildrive read-only by default with a per-share rw switch behind
   presence; shares refuse flagged folders; projectsDir moves to /work/projects. See Next 2.
2. Decided: grant file sharing to the box's tag. See Next 3.
3. Decided: sidecar kept, OAuth client for renewal, per-computer credentials. See Next 4 and its
   limit.
4. Agent nodes: the image change (tini as root, a root-only tailnet side on 7001 with its own
   token, `setpriv` down to uid 1000, which needs SETUID and SETGID at start), and whether that
   side proves itself before vyred sends the key.
5. Guests: allow `threads.get`; narrow `threads.list` for guests; keep the tools in the new
   `network` module or rename them.
6. Webhooks: keep dropping repeated bodies; per-route secret grants.
7. Decided: `link.health` on the box answers modules and the owner only. See Next 1.
8. Company tailnets: grants and guests trust whoever edits the policy; add an onboarding check
   that the owner alone edits it?

## Steps for the user

Sample names: the owner is alex@example.com, the Mac is `alex-mac` (100.64.0.7), the box is
`tag:vyre-box` (100.64.0.5, `vyre.tail0000.ts.net`). Replace them with the real ones. Merge each
snippet's keys into the one tailnet policy file in the admin console (Access controls).

### Taildrive (box folders on the Mac)

```json
{
  "tagOwners": { "tag:vyre-box": ["alex@example.com"] },
  "hosts": { "alex-mac": "100.64.0.7" },
  "nodeAttrs": [
    { "target": ["tag:vyre-box"], "attr": ["drive:share"] },
    { "target": ["alex@example.com"], "attr": ["drive:access"] }
  ],
  "grants": [
    { "src": ["alex-mac"], "dst": ["tag:vyre-box"],
      "app": { "tailscale.com/cap/drive": [{ "shares": ["projects", "glass-files"], "access": "ro" }] } }
  ]
}
```

Then on the box: `vyre call --tty files.drive.share '{"name":"projects"}'`, and
`vyre call files.drive.audit`. For writes from Finder: `"access": "rw"` in the grant,
`vyre call --tty files.drive.access '{"name":"projects","mode":"rw"}'`, then the step it answers:
`VYRE_DRIVE_ACCESS=rw` in `/srv/vyre/.env` and `docker compose up -d`. Remount on the Mac.

### Taildrop (files to the box)

Admin console, Settings: Send Files on. The box stays a tagged server, so grant file sharing to
its tag, owner only, not `autogroup:member`, which would let anyone sharing or family-sharing
into this tailnet drop a file onto the box too, where an agent may read it. The grant's exact
form is checked on the first real run:

```json
{ "grants": [ { "src": ["alex@example.com"], "dst": ["tag:vyre-box"],
    "app": { "https://tailscale.com/cap/file-sharing-target": [{}] } } ] }
```

### Tailscale SSH (for `vyre box add`)

On the server, `tailscale up --ssh` (or `tailscale set --ssh`), with a policy SSH rule. `action`
is `check` (a fresh sign-in each time), not `accept` (which would let any of the owner's own
devices, a phone included, SSH straight in with no fresh sign-in). `users` is the unix account on
the server itself, the admin account this server was set up with, never a service account like
`vyre` or `vyre-agent`:

```json
{ "ssh": [ { "action": "check", "src": ["alex@example.com"], "dst": ["tag:vyre-box"], "users": ["alex"] } ] }
```

### HTTPS (a ts.net address)

Admin console, DNS, HTTPS Certificates, Enable HTTPS. Onboarding shows this step when
`tailscale cert` fails for this reason.

### Tailnet Lock (optional)

On the Mac: `tailscale lock` to read its key (`tlpub:...`); the box's key is on the onboarding
card and in Settings, Network. Then, on the Mac:
`tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> <box key>`.
Save both disablement secrets in the Vault.

### Glass egress through the Mac

1. On the Mac: Tailscale menu, Exit Node, Run as Exit Node.
2. Admin console: Machines, alex-mac, Edit route settings, Use as exit node. Settings, OAuth
   clients: Generate, scope Auth Keys (write), tag `tag:vyre-egress`. The client secret does not
   expire, so nothing needs renewing. A reusable, ephemeral, pre-approved auth key tagged
   `tag:vyre-egress` also works (it expires). Never a single-use key: the sidecar keeps its state
   in memory and logs in again on every restart, so a single-use key fails the first restart with
   "authkey already used" and the sidecar never comes back.
3. Policy:
   ```json
   {
     "tagOwners": { "tag:vyre-egress": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-egress"], "dst": ["autogroup:internet"], "ip": ["*"] } ]
   }
   ```
4. On the box, in `/srv/vyre/.env` (not `vyre.env`): `VYRE_EGRESS_AUTHKEY=tskey-client-...?ephemeral=true&preauthorized=true`,
   `VYRE_EGRESS_EXIT_NODE=alex-mac`, and `COMPOSE_FILE=box/compose.yml:box/compose.egress.yml`.
   (A reusable ephemeral key goes in the same variable as it is. Not a single-use key: see 2.)
   Then `docker compose up -d` and
   `vyre call --tty computers.egress.set '{"enabled":true,"sites":["portal.northwind.example"]}'`.
5. Check: `vyre call computers.egress.status`. Its `gate` says whether listed sites can go out now
   (`allowed`) and why not (`reason`, for example the Mac is not offering its exit node).
   `docker compose logs egress` shows each change once. Test the PAC with the computer image's
   Chromium only: chromedp/headless-shell ignores every PAC, `data:` or http.

### Vault passes authorized by the policy (grants)

The holder dana@northwind.example reaches the box through machine sharing:

```json
{ "grants": [ { "src": ["dana@northwind.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:7301"],
    "app": { "vyre.run/cap/vault": [ { "items": ["northwind-*"], "mode": "relayed" } ] } } ] }
```

Then in the box's config: `"vault": { "relay": { "identity": "whois", "grants": "require" } }`,
restart vyred, and check with `vyre call vault.grants.status`. `7301` is `vault.relay.port`.

### Guests from another tailnet

1. Admin console: Machines, the box, the "..." menu, Share, invite sam@harlow.example.
2. Either list them:
   `vyre call --tty network.guests.add '{"login":"sam@harlow.example","tools":["glass.open","glass.close","threads.list"]}'`,
   or grant them:
   ```json
   { "grants": [ { "src": ["sam@harlow.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"],
       "app": { "vyre.run/cap/guest": [ { "tools": ["glass.open", "glass.close", "threads.list"] } ] } } ] }
   ```
3. `vyre call --tty network.guests.enable '{"on":true}'`, then `vyre call network.guests.check`.

### A tagged node for each agent (after the image change)

1. Policy (and remove any allow-all `"src": ["*"]`, which covers tags):
   ```json
   {
     "tagOwners": { "tag:vyre-agent": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-agent"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"] } ]
   }
   ```
2. Admin console, Settings, Keys: a reusable, ephemeral, pre-approved key tagged `tag:vyre-agent`.
3. `vyre vault put tailscale-agent-authkey`, then `vyre vault grant tailscale-agent-authkey computers`.
4. `vyre call --tty computers.tailnet.set '{"enabled":true}'`.

### Webhooks through Funnel

1. Policy: `"nodeAttrs": [ { "target": ["tag:vyre-box"], "attr": ["funnel"] } ]`, and HTTPS on (above).
2. On the box:
   ```
   vyre hooks on
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   cd /srv/vyre && docker compose exec tailscale tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders
   ```
3. The sender posts to `https://vyre.tail0000.ts.net:8443/hooks/northwind-orders`. Check with
   `vyre hooks status`.
4. To close: `vyre hooks close northwind-orders`, then
   `tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off`; after the last route,
   `tailscale funnel --https=8443 off`.

### Desktops that join the tailnet on their own (ADR 0046)

1. In the admin console, Access controls: add `"tag:vyre-device": ["<your login>"]` under
   `tagOwners`, and one grant from `tag:vyre-device` to this box on its port
   (`onboard.tailscale {action:"policy"}` writes both out). Check that no broader rule
   (`autogroup:member` to `*`) also covers `tag:vyre-device`.
2. Settings, OAuth clients: make one client with the `auth_keys` and `devices:core` scopes, both
   limited to `tag:vyre-device`, nothing else.
3. Store it in the box's vault as `tailscale-mint-oauth`:
   `{"client_id": "...", "client_secret": "..."}`.
4. Pair a Linux or Windows desktop as usual; it joins by itself. A Mac box waits for vyre-core.

## Changed contracts

- **names** (28 Sep, ADR 0046, own): `classify()` takes `deviceOf`; a `tag:vyre-device` node is
  `device:<id>` once bound, `bindable` otherwise. New route `POST /v1/tailnet/bind` on the
  tailnet listener, open only to an unbound `tag:vyre-device` node. Streams admit a bound device.
- **relay** (28 Sep, ADR 0046, own): internal tools `relay.devices.tailnet` and
  `relay.devices.bind` (module:names only), owner tool `relay.tailnet.status`, events
  `device.joined`, `tailnet.tried`, `tailnet.revoke-failed`, `needs.vault: tailscale-mint-oauth`,
  channel-only path `POST /v1/relay/tailnet/key`, pairing hello field `tailnet: "join"`,
  `relay.status.tailnet` for this machine as another box's desktop.
- **onboard** (28 Sep, ADR 0046): the policy snippet gains `tagOwners["tag:vyre-device"]` and
  one grant to the box's port while `relay.tailnet.status.available`.
- **relay/client** (28 Sep): `pairOffer`/`pair` take `tailnet: true`; the ticket record is sealed
  (`vyre-pair-enc`), opened inside `resolveTicket()`.

Listed by the area they touch, so the merge can go in order. Everything below is off by default.

- **core/link** (28 Sep, ADR 0042, new file, own): `peers.js` exports `ownedNode(ctx)`,
  `openPeer(ctx)`, `selfIdentity(ctx)`, for federation's move engine to wire into its own
  `seams.set(ctx.paths.root, ...)`. No change to `transport.js` or `mac.js`/`box.js`.
- **relay** (28 Sep, ADR 0042, own): new module-only tool `relay.devices.node` (`{ stableId,
  staticKey, node: { stableId, name } | null }`), added to `does.tools`.
- **relay/worker** (28 Sep, ADR 0045, own): new Durable Object `PairTicket`, bound `TICKETS` in
  wrangler.toml (new migration entry too); `RouteRelay`'s control socket handles `{ t: "ticket",
  loc, record, mac, exp }` post-auth (previously silent); the Worker's top-level `fetch` handles
  `POST /v1/pair`, an optional per-address `PAIR_LIMITER` binding (misses only; no global limit). Not deployed, code and tests only, per the lead; deploying needs the user's yes.
- **relay/worker/fake-cf.js** (28 Sep, shared test harness, own): `createRuntime` takes an
  optional `classes` map for Durable Object bindings beyond `ROUTES`; a namespace's `.fetch()`
  accepts `(url, init)` as well as a `Request`; `FakeStorage` gains `deleteAll()`. `object(name)`
  for `ROUTES` is unchanged.
- **relay** (28 Sep, own): `relay.join` refuses on darwin (`not_available_here`) until vyre-core
  (ADR 0040) holds the joining device's own key; new export `macCoreRefusal(platform)` (renamed
  from `relayJoinRefusal`, now shared with `relay.pair.ticket`); its `presence.when` no longer
  always requires a proof (skips the prompt on darwin, since the call can only refuse there); its
  Touch ID prompt now sanitises the relay host the same way as the box's own name (shared
  `promptSafe` helper, moved up so `admit()` can use it too, widened to Unicode format/bidi
  characters, host capped at 64).
- **relay** (28 Sep, ADR 0045, own): tool `relay.pair.ticket` (input `{}`, output
  `{ ticket, expiresAt, connected }`), refuses on darwin like `relay.join`; a device's own name at
  pairing (both the classic QR and ticket paths) is now sanitised with `promptSafe`, capped at 64,
  in place of the old plain `NAME` regex check; event `relay.paired { device, name }`, only for a
  ticket pairing; `core/relay/wire.js` exports `TICKET_BYTES`, `TICKET_TTL`, `ticketDerive(which,
  ticket)`, `ticketMac(ticket, record)`; `core/relay/link.js`'s `relayLink()` return gains
  `registerTicket({ loc, record, mac, exp })` (queued until the control socket is connected, sent
  once, best effort); module.json `does.tools` and `watches.emits` updated (a tool or event a
  module's own manifest doesn't list fails that module's start silently, with every other module
  unaffected, the gotcha of this session).
- **relay/node** (own): `POST /v1/pair` (body `{ loc }`, answers `{ record, mac }` or 404,
  rate-limited per IP and globally); the control socket, previously silent after auth, now handles
  `{ t: "ticket", loc, record, mac, exp }`.
- **relay/client** (own): new export `pairTicket(ticket, o)`; `pair()`'s handshake body extracted
  into an unexported `pairOffer(offer, o)`, which both now call; no change to either's return
  shape or to `connect()`.
- **onboard**: tool `onboard.join` (`{ action: "status"|"tailscale"|"relay"|"verify", step?,
  node?, becomeDevice? }`), box role (matches onboard's own). Forwards only, through onboard's own
  functions for tailscale and ctx.call for relay/link/onboard.machine; reads and writes nothing of
  its own.
- **link** (own): tool `link.health`; `link.status` box gains `stableId`; `link.peers` rows gain
  `stable_id`; `parseWhois`/`capValues` in `core/link/transport.js` (whois carries `tags`, `caps`);
  link pairing refuses `tailnet-guest:*` and `tailnet:agent:*`.
- **names** (box's listener): `identifier` returns `kind` (owner, guest, agent); callers
  `tailnet-guest:<login>` and `tailnet:agent:<name>`; peer meta `{ node, stableId, login, tags,
  caps, kind, agent? }`; `core/names/guests.js` (`GUEST_SAFE`, helpers); `lockStatus`, `parseLock`,
  `peers`, `parsePeers` in `core/names/tailscale.js`.
- **daemon**: guests reach only their allowed tools within `GUEST_SAFE`, 404 otherwise;
  `tailnet:agent:*` also needs a matching `x-vyre-agent-key`; `tailnet-guest:` is a label the
  socket cannot claim.
- **network** (new module, box): `network.guests.list|add|remove|enable|check`; events
  `guest.added`, `guest.removed`; config `network.guests { enabled: false, people: {} }`.
- **presence**: HUMAN_ONLY gains `files.drive.share|unshare|access`, `network.guests.add|remove|enable`,
  `hooks.enable|open|close`, `computers.tailnet.set`, `computers.egress.set`; presence refuses
  `tailnet-guest:*` whatever the proof.
- **gate**: `person()` refuses guests and agent nodes.
- **memory**: `viaTailnet` no longer reads `tailnet:agent:*` as the owner.
- **vault**: config `vault.relay.grants` (`"off"`|`"require"`); whois relay meta gains `peer`;
  tool `vault.grants.status`; `vault.pass.create` may return `warning`; exports
  `relay.VAULT_CAP`, `relay.grantCovers`, `whoisMeta`.
- **files**: tools `files.send`, `files.drive.status|share|unshare|audit|url|mount|unmount|open|local`;
  events `files.sent`, `files.received`, `drive.exposed`; config `files.inbox`,
  `files.drive.shares`, `files.drive.access`; CLI `vyre send`.
  Taildrive per-share access (ea158df): tool `files.drive.access { name, mode }` answering
  `{ name, access, mount: { want, now, change, step? } }`; `files.drive.shares` entries may be
  `{ path, access }` (or `{ access }` for a default share); `files.drive.status` rows gain
  `access` (top-level `access` is rw when any share is); `files.drive.share` answers the share's
  own access and may refuse `unsafe_share` with `detail.found` (and `detail.tooBig`);
  `files.drive.audit` answers `unsafe: [{ share, found, why? }]`, and `drive.exposed` carries
  `unsafe`; `core/files/safety.js` exports `secretName`, `HOME_DENIED`, and the guard
  `isDenied`; `shareSpecs`, `mountStep`, `SCAN_LIMIT` exported from `core/files/drive.js`.
- **glass**: `glass.open` answers `link`; `glass.close` from a guest closes only its own sessions;
  config `glass.egress`.
- **computers**: tools `computers.egress.status|set`, `computers.tailnet.status|set`, internal
  `computers.node.agent`; events `computer.joined`, `computer.left`; `computers.watch` takes
  `slow`; `Pool.ticket(..., { slow })`; columns `egress`, `stable_id`, `node`; computer env
  `VYRE_PROXY_PAC`; `Inspection.ports.tailnet` (optional); manifest `needs.vault`
  `["tailscale-agent-authkey"]`; config `computers.tailnet`; new, unwired
  `image/computerd/tailnet.js`; `entrypoint.sh` PAC check.
- **watchers**: watcher.json `on` and `where` (schedule `"event"`), run trigger `"event"`,
  `watchers.test` takes `event`, runtime dep `listen`, `folder.matches` exported, the
  write-a-watcher skill documents it.
- **hooks** (new module, box): `hooks.enable|open|close|list|status|delivery`; events
  `hook.received`, `hook.opened`, `hook.closed`; table `hooks_deliveries`; config `hooks`;
  CLI `vyre hooks`.
- **onboard**: `onboard.tailscale` action `lock`; the HTTPS step shown as plain steps, Lock after it.
- **cli / install**: `vyre box add` and `move` prefer Tailscale SSH; `core/cli/tailnet.js` peers
  carry `ssh`; `ssh.js` opens `.ts.net` targets interactively first.
- **deck**: `deck/js/health.js` (one formatter, dots in Chat and Glass headers); `deck/js/lock.js`;
  Settings Network rows; new fixtures `files.json`, `hooks.json`, `network.json`, `link.json`.
- **capsule**: IPC `capsule:send-file`, preload `sendFile`, option-return on a file row,
  `SEND_TIMEOUT`, the box dot, Taildrive-first open.
- **box**: the tailscale service mounts `vyre-work:/work:${VYRE_DRIVE_ACCESS:-ro}`; new
  `box/compose.egress.yml`. Its services: `egress` is now the gate (vyre image, `node
  /opt/vyre/core/computers/egressgate.js`, alias `egress` on `computers`, also on `egress`),
  and the tailscaled sidecar is `egress-node` (SOCKS5 `:1056`, `TS_SOCKET` in the new volume
  `egress-sock`, networks `default` and `egress` only, `--advertise-tags=tag:vyre-egress`). New
  internal network `egress` (`vyre-egress`) and the project's `default` network. `PROXY`
  (`egress:1055`) is unchanged, so computers and the PAC need nothing new.
- **computers (egress)**: new `core/computers/egressgate.js` (env `VYRE_EGRESS_GATE_HOST`,
  `_PORT`, `_STATUS_PORT`, `VYRE_EGRESS_UPSTREAM`, `VYRE_EGRESS_SOCKET`; GET /status on 1057);
  `egress.gateStatus()` and `GATE_STATUS_PORT` (test override `VYRE_EGRESS_GATE_STATUS`);
  `computers.egress.status` gains `gate: { answers, allowed, reason } | { answers: false, why }`.
- **perf-check** (scripts/perf-check): waits for `memory.curate` after indexing, before the idle
  window, so Memory's startup pass is not counted as idle work.
- **names** (27 Sep): config `network.origins` (default `["https://app.vyre.run"]`); `names()`
  takes `webSession`; the router's peer may carry `origin` and `webSession`; cross-origin
  `GET /v1/health` answers `{ reachable: true }` in the listener; `401 web_session_required`.
- **names** (28 Sep): `GET /v1/whoami` on the direct tailnet path (not the hosted app's CORS
  path): owner or guest only (an agent's node gets `403`), rate-limited 10/minute per
  node/stableId (`429`), answers `{ kind, name }` (name only for the owner).
- **deck** (27 Sep, pwa's file): deck/views/settings.js, the Network share row is titled
  "VyreDrive" and its line reads "VyreDrive (built on Tailscale's Taildrive) opens your box's
  folders in Finder on your Mac." (was "...open in Finder on your Mac through Taildrive."), in
  both the on and off states (1498c4a).
- **presence** (27 Sep): `files.drive.access` is PERSON_ONLY, no longer HUMAN_ONLY.
- **names guests** (27 Sep): GUEST_SAFE drops `glass.open`.
- **files** (27 Sep): the share scan's skips and `.git/config` check (`gitConfigCredential`).
- **config/projects** (27 Sep): `workDir()`, `oldProjectsDir()`, `boxProjectsDir()`; a box's
  default `projectsDir` is `/work/projects` when `/work` exists; `core/projects/move.js`,
  event `projects.moved`, file `<vyre home>/projects-moved.json`.
- **config**: defaults for `glass.egress`, `computers.tailnet`, `hooks`, `network.guests`.

Suggested merge order: link and names, daemon and presence, vault, files, computers, watchers and
hooks, then deck, capsule and onboard. They are one branch here, so this matters only if the
integrator splits it.

## 2 Oct 2026 status (relaunch)

- Pushed, each after targeted tests plus docs, reach, boundaries and hygiene on the test box: 023-pair-window af1a30e7c, 023-companion e448cd652 (not usable until a transport exists), 023-app-relay-check 7fa12e885 (app-boot run 36966573078), 022-device-names f299fc4c1 (#65), and 023-relay-deploy b8339c039 (pair-window merged with pair-limit a9c9d8dd9, the one branch for the relay redeploy). 022-relay-flake cd691f322 (#13) was already pushed and its relay loop is green on Node 22 and 24.
- Next: relay-deploy.yml needs the sha on work/stage-0.2; I dispatch it once the integrator lands 023-relay-deploy, then the lead approves the deploy environment. The edge rule stays off until CLOUDFLARE_WAF_TOKEN exists. 023-presence-trim is held, unpushed.
- 0.3: ADR 0050 claimed (the built-in network, supersedes 0046's transport). Section 12b of team/0.3/PLAN-built-in-network.md is my confirmation of platform's sections 5 to 8 and 12; the spike list is there.
