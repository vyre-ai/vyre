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
- ADR 0026 draft (proposed), this file.

## Doing
- Waiting for the lead's reply on the design summary before the big build.

## Next
1. `relay/protocol/`: Noise IK (node:crypto), framing, pairing URL codec. Unit tests with the
   Noise test vectors (cacophony) for IK_25519_AESGCM_SHA256.
2. `relay/node/`: the reference relay (signed box sockets, limits), tests.
3. `core/relay/`: keys, control/data sockets, device store, pairing tools, stream-to-HTTP
   bridge, `device:` caller. In-process tests with the node relay and a fake device.
4. `relay/worker/`: Worker + DO, tested with a fake DO state (no deploy).
5. `relay/client/`: the TypeScript transport for the Expo app (@noble), tested in Node.
6. Onboarding card and Settings, Devices (with deck-design / docs owners).
7. perf-check numbers for the idle box with the relay on.

## Needs from others
- lead: approve the design (ADR 0026), and later a real Cloudflare deploy (Workers Paid, $5 a
  month, recommended before launch; free plan is fine for testing).
- mobile (ADR 0018/0027): the `device` presence method (a168aa6 on work/mobile) must land on
  main first; the app imports `relay/client/` as its second transport; scan screen.
- security/presence owner: `relay.pair.start`, `relay.devices.remove|rename`, `relay.enable|disable`
  join HUMAN_ONLY; pairing enrolls a `device` presence key directly (today `presence.enroll`
  by code needs caller `tailnet:<owner>`).
- tailnet: `ownerDevice()` replacing `ownerOverTailnet` at its call sites.

## Changed contracts (planned, not landed)
- `core/modules/index.js`: `ownerDevice(caller)`; `callerAllowed` uses it.
- `core/daemon/index.js`: `FORBIDDEN_LABEL` gains `device:`.
- `core/harness/rules.js`: `registryRules` person check uses `ownerDevice`; floor denies Bash
  naming the relay key files.
- Prefix checks switched to `ownerDevice`: core/gate/index.js:64, core/link/box.js:40,
  core/files/drive.js:213, core/modules/federate.js:13, core/switchboard/index.js:737,
  core/memory/index.js:114,334, core/network/index.js:31, core/glass/index.js:204,
  core/onboard/index.js:219.
- `core/presence/index.js`: HUMAN_ONLY additions above.
- New events: `relay.connected`, `relay.disconnected`, `relay.device.paired`, `relay.device.removed`.
