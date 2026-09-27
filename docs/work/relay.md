# relay

Branch: work/relay · Worktree: ../vyre-relay · ADR 0026 (docs/adr/0026-relay.md)

## Scope

A second way to reach the box besides Tailscale: the box dials out to a relay, and paired devices
meet it there over an end-to-end encrypted Noise IK channel, paired by QR code. Owns
`relay/` (worker, node relay, shared protocol, client transport), `core/relay/` (the box module),
`docs/adr/0026-relay.md`, this file. Small changes elsewhere go through their owners' contracts,
listed under Changed contracts.

Paseo reference: <team-dir>/../reference/paseo (Apache 2.0, commit d7b7016).

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
  ping answered at the relay. 7/7. package.json test glob gains relay/**/*.test.js.

- Box module core/relay/ (index, link, bridge, pairing, module.json): keys, signed control
  socket, data sockets, admit (pairing secret or paired key), device:<id> through ctx.handler,
  tools and events. test/relay.test.js: 7/7 end to end on testbox (pair, router as device,
  presence still required, one-time QR, stranger refused, first-device path closes, remove
  closes the live channel, socket cannot claim device:, SSE event live through the relay).
  Neighbour suites (guests, daemon, modules, harness, presence, hygiene, docs-check) green but
  the pre-existing screenshot mtimes.

## Doing
- Lead has the design summary (no reply yet). Next up regardless: relay/worker/.

## Next
1. relay/worker/: Worker + DO (hibernation, signed box via WebCrypto Ed25519, autoresponse
   ping), tested with a fake DO state. No deploy without the lead.
2. `vyre relay` CLI (status, pair with a terminal QR, devices), and WebSocket streams through
   the bridge (Glass).
3. `relay/worker/`: Worker + DO, tested with a fake DO state (no deploy).
4. `relay/client/`: the TypeScript transport for the Expo app (@noble), tested in Node.
5. Onboarding card and Settings, Devices (with deck-design / docs owners).
6. perf-check numbers for the idle box with the relay on.

## Needs from others
- lead: approve the design (ADR 0026), and later a real Cloudflare deploy (Workers Paid, $5 a
  month, recommended before launch; free plan is fine for testing).
- mobile (ADR 0018/0027): the `device` presence method (a168aa6 on work/mobile) must land on
  main first; the app imports `relay/client/` as its second transport; scan screen.
- security/presence owner: `relay.pair.start`, `relay.devices.remove|rename`, `relay.enable|disable`
  join HUMAN_ONLY; pairing enrolls a `device` presence key directly (today `presence.enroll`
  by code needs caller `tailnet:<owner>`).
- tailnet: `ownerDevice()` replacing `ownerOverTailnet` at its call sites.

## Changed contracts
- Landed on work/relay: `core/modules/index.js` exports `ownerDevice(caller)`; `callerAllowed`
  uses it for "deck" and "tailnet" entries (mobile's fad6f0f also touches callerAllowed: merge
  by keeping both, ownerDevice covers tailnet owners). `core/daemon/index.js` `FORBIDDEN_LABEL`
  gains `device:`. `core/harness/rules.js` `registryRules` person check uses `ownerDevice`.
  `scripts/lib/docs/check.js` OWNERS gains "relay". package.json test glob gains relay/**.
- New module `relay`: tools relay.*, events relay.connected, relay.disconnected, device.paired,
  device.removed; config `relay: { enabled, url }` (default url wss://relay.vyre.run).
- Planned, waiting on the lead: floor denies Bash naming relay/keys.json; HUMAN_ONLY additions;
  prefix checks switched to `ownerDevice`: core/gate/index.js:64, core/link/box.js:40,
  core/files/drive.js:213, core/modules/federate.js:13, core/switchboard/index.js:737,
  core/memory/index.js:114,334, core/network/index.js:31, core/glass/index.js:204,
  core/onboard/index.js:219.
- `core/presence/index.js`: HUMAN_ONLY additions above.
