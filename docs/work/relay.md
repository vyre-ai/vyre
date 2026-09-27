# relay

Branch: work/relay · Worktree: ../vyre-relay · ADR 0026 (docs/adr/0026-relay.md)

## Scope

A second way to reach the box besides Tailscale: the box dials out to a relay, and paired devices
meet it there over an end-to-end encrypted Noise IK channel, paired by QR code. Owns
`relay/` (worker, node relay, shared protocol, client transport), `core/relay/` (the box module),
`docs/adr/0026-relay.md`, this file. Small changes elsewhere go through their owners' contracts,
listed under Changed contracts.

Paseo reference: `<team-dir>/../reference/paseo` (Apache 2.0, commit d7b7016).

## Design in one screen

- Box keys in `~/.vyre/relay/`: `box.key` (X25519, Noise static, in the QR) and `route.key`
  (Ed25519, proves the route to the relay). Route id = base32(sha256(routePub)).
- Relay: Cloudflare Worker + one DO per route, hibernating, no timers. Box sockets are signed
  (fixes Paseo's unauthenticated role=server). Devices connect unauthenticated; the box admits.
  `relay/node/` is the same protocol in plain Node for tests and self-hosting.
- Channel: Noise_IK_25519_AESGCM_SHA256, node:crypto on the box (no deps), @noble on Expo.
  Per-direction keys, counter nonces, forward secrecy (fixes Paseo's replay, reflection, no FS).
- Inside: multiplexed req/res/ws streams, turned into real HTTP requests on the box through an
  in-memory duplex and `ctx.handler(policy)`, so every route is reused.
- Caller `device:<id>`, a person like `tailnet:<owner>`, via one helper `ownerDevice()`.
  Presence unchanged: the phone's `device` presence key (ADR 0018) is enrolled at pairing.
- Pairing: HUMAN_ONLY `relay.pair.start`, one-time 16-byte secret, 10 minutes. First device via
  onboarding (touchid on a Mac; on Linux single-slot detection plus reset).

## Done
- d76b7d7 claimed ADR 0026.
- 1dc5c35 ADR 0026 draft (proposed), this file. Design summary sent to the lead.
- 3f858fe core/relay/noise.js: Noise_IK_25519_AESGCM_SHA256 in node:crypto, matches the
  cacophony vector byte for byte (handshake and 4 transport messages); replay, reflection,
  reorder, wrong key, wrong prologue, low-order key, rekey tests. 8/8.
- core/relay/wire.js (route id, box auth, limits, close codes) and relay/node/server.js, the
  reference relay: signed box control socket, ticketed data sockets, buffering, caps, text
  ping answered at the relay. 7/7. package.json test glob gains `relay/**/*.test.js`.

- Box module core/relay/ (index, link, bridge, pairing, module.json): keys, signed control
  socket, data sockets, admit (pairing secret or paired key), `device:<id>` through ctx.handler,
  tools and events. test/relay.test.js: 7/7 end to end on testbox (pair, router as device,
  presence still required, one-time QR, stranger refused, first-device path closes, remove
  closes the live channel, socket cannot claim device:, SSE event live through the relay).
  Neighbour suites (guests, daemon, modules, harness, presence, hygiene, docs-check) green but
  the pre-existing screenshot mtimes.

- 97300e6 relay/worker/: Worker + DO (hibernation, WebCrypto Ed25519, storage-backed buffer,
  optional DEVICE_LIMITER), fake runtime that rebuilds the DO after every event, link.js runs
  unchanged against it. 29 tests.
- 370ca7a relay/client/: device side for the one app, zero deps: Noise over WebCrypto
  (non-extractable device key) or injected @noble, byte-compatible channel, reconnect with
  fresh handshake, 60 s visible-only keepalive, SSE resume by Last-Event-ID, one retry with the
  same Idempotency-Key, paths.js tailnet/relay failover (Direction A). 31 tests.
- 7e46854 bridge passes Idempotency-Key (+ bridge.test.js); a replaced box (4409) waits 5 min.
- ADR 0026 accepted, section 10 "The hosted web app" (app.vyre.run, 7 trust mitigations),
  pairing notice, sections 2-4 and 8 synced with the code, 0029/0030 tie-ins.
- WebSocket streams through the bridge (core/relay/wsclient.js): upgrade via ctx.upgrader as
  `device:<id>`, pings answered by the bridge, one whole message per data frame.
- Box side of section 10: kind web, WEB_DENY via the handler's tool policy, relay.devices.trust,
  web_expiry_days (checked at admit and in list, no timer), build check (releases.js/.json),
  richer device.paired.
- testbox: `core/relay`, `relay/**`, `test/relay.test.js` 93/93; docs tests 50/50.

## Doing
- Redial bug FIXED (lead asked during the pause): link.js and client.js treat a pre-open
  `error` as a failed dial; 30 s dial timer in link.js. resilience's two chaos todos pass with
  the fix (their branch + this fix, 54/54); they flip the todos on their branch.
- PAUSED (lead, 27 Sep 2026): the user is refocusing on the native core. 4d58d4b is in batch 3b.
  Nothing in flight; everything is pushed. The Cloudflare deploy stays deferred until the lead
  says the phone spike or the hosted app needs a live relay (check the vyre.run zone is on
  Cloudflare first; use box-deploy's wrangler credentials; custom_domain route).

## Next
- From mobile (apps/app on work/mobile 24e2091a wires relay/client), for when relay resumes:
  (1) README: say createPaths takes `fetch` (RN needs expo/fetch to stream); (2) a `randomBytes`
  option for paths.js newKey() (Hermes has no getRandomValues); (3) a start-on-the-relay mode:
  `prefer` path plus a background probe that moves up to direct, so a phone's first request does
  not wait 1.5 s; (4) make relay/client strict-tsc clean (85 errors, 9 files) so the app drops its
  hand-written declarations.
0. (e2e c8e00e7 has the contract; relay.device.presence added in this commit for the native path.
   Web: e2e a33ad94 has it. WAITS until after the native-core milestone (lead). Then, in admit()
   for a web pairing whose hello carries a passkey: ctx.call("presence.enroll", { kind: "passkey",
   name, public_key: <base64url SPKI DER>, alg: -7|-8|-257, rp_id: "app.vyre.run", credential_id,
   device: <device id> }) as module:relay, and store credential_id as presence_key so
   relay.devices.remove's presence.remove drops the binding. Loader sign-in: POST
   /v1/presence/challenge { tool: "presence.person.start", input: { key: <JWK> }, method: "passkey" },
   navigator.credentials.get on app.vyre.run, then POST presence.person.start { key } with
   x-vyre-presence `passkey id=<challenge> cred= ad= cd= sig=`; keep { token } and sign with
   x-vyre-proof. Tests: e2e's test/person.test.js.)
   PAUSED: the relayed-device sign-in (ADR 0032, the ceremony the lead approved). Relay side:
   (a) at web pairing, the loader makes a passkey with rpId app.vyre.run and sends it in the
   hello; admit() passes it to presence for enrollment bound to the device id; (b) the loader
   and the native app call presence.person.start over the channel and keep the returned token,
   signing calls with x-vyre-proof (the bridge already passes both headers).
   NEEDED FROM e2e before starting: (1) the registry's person gate uses `ownerDevice(caller)`,
   not `ownerOverTailnet(caller)`, so `device:*` is gated (MERGE HAZARD until done); the router
   treats the relay's peer (kind "device", stableId = device id) as a device with nodeId =
   stableId; (2) presence.person.start accepts, for a `device:<id>` caller, method "device" (the
   phone's enrolled P-256 key) and method "webpasskey" (a WebAuthn assertion, rpId app.vyre.run,
   origin https://app.vyre.run, only for the key enrolled for that device id), and returns the
   same `Vyre <id>.<secret>` token pinned to the device id, taking the app's ES256 proof key;
   (3) presence.enroll accepts kind "webpasskey" from caller module:relay with { device,
   credential_id, public_key, alg }, bound to that device id; (4) the Mac Secure Enclave key
   (lead approved) as a `device` presence key, so a linked Mac can mint relay.pair.start.
1. After tests: CHANGELOG entries for relay/app, relay.web.*, person-session headers.
2. Hand polish-cli the CLI verbs for `vyre phone add`.
3. Surfaces show the `device.paired` notice with one-tap removal (pwa, capsule, mobile own the UI).
4. Onboarding card and Settings, Devices (with deck-design / docs owners); docs site publishes
   relay/app/pair/ at vyre.run/pair.
5. perf-check numbers for the idle box with the relay on.
6. First real Cloudflare deploy once the lead confirms the command.

## Needs from others
- polish-cli: one QR encoder. Whoever reaches main second swaps `vyre relay pair` to
  core/cli/qr.js `terminal(qr(url))` (polish-cli 6eaa6a0) and deletes terminalQr + its test.
- tailnet: CORS on vyred for https://app.vyre.run (the /v1/health probe and API calls), or
  Direction A's direct path is blocked in the browser.
- presence owner: enroll a passkey presence key (rp app.vyre.run) sent at pairing by a web
  device.
- resilience: the Registry.call idempotency layer; the bridge already forwards the header.
- lead: go for the first real Cloudflare deploy (design and $5/mo spend are approved).
- mobile (ADR 0018/0027): the `device` presence method (a168aa6 on work/mobile) must land on
  main first; the app imports `relay/client/` (see relay/client/README.md) with paths.js on
  top, injects @noble on native and an AppState visibility adapter; scan screen; the web
  target's build for app.vyre.run.
- security/presence owner: `relay.pair.start`, `relay.devices.remove|rename`, `relay.enable|disable`
  join HUMAN_ONLY; pairing enrolls a `device` presence key directly (today `presence.enroll`
  by code needs caller `tailnet:<owner>`).
- tailnet: `ownerDevice()` replacing `ownerOverTailnet` at its call sites.

## Changed contracts
- Landed on work/relay: `core/modules/index.js` exports `ownerDevice(caller)`; `callerAllowed`
  uses it for "deck" and "tailnet" entries (mobile's fad6f0f also touches callerAllowed: merge
  by keeping both, ownerDevice covers tailnet owners). `core/daemon/index.js` `FORBIDDEN_LABEL`
  gains `device:`. `core/harness/rules.js` `registryRules` person check uses `ownerDevice`.
  `scripts/lib/docs/check.js` OWNERS gains "relay". package.json test glob gains `relay/**`.
- New module `relay`: tools relay.*, events relay.connected, relay.disconnected, device.paired,
  device.removed; config `relay: { enabled, url }` (default url wss://relay.vyre.run).
- Planned, waiting on the lead: floor denies Bash naming relay/keys.json; HUMAN_ONLY additions;
  prefix checks switched to `ownerDevice`: core/gate/index.js:64, core/link/box.js:40,
  core/files/drive.js:213, core/modules/federate.js:13, core/switchboard/index.js:737,
  core/memory/index.js:114,334, core/network/index.js:31, core/glass/index.js:204,
  core/onboard/index.js:219.
- `core/presence/index.js`: HUMAN_ONLY additions above.
