---
title: ADR 0026: The relay, a second way to reach the box
summary: The box dials out to a small public relay, and paired devices meet it there over an end-to-end encrypted Noise channel set up by scanning a QR code. No Tailscale, no open port, no account. Modelled on Paseo's relay, with device keys, per-direction keys and an authenticated box route added.
audience: builders
owner: relay
status: proposed
---

# ADR 0026: The relay, a second way to reach the box

Status: proposed, 27 Sep 2026 · Workstream: relay · Related: ADR 0002 (network and identity),
ADR 0004 (presence), ADR 0014 (tailnet), ADR 0018 (mobile), ADR 0027 (one Expo app)

## Context

Today the only way to reach the box from a phone or a laptop is the tailnet (ADR 0002). It is a
strong design: identity is the WireGuard source address, checked by `tailscale whois`, and no
header is ever trusted. It is also the hardest step of onboarding. People have to make a
Tailscale account, install the app on every device, sign in on each one and sometimes enable
HTTPS in an admin console, before they see anything of Vyre.

We want a second path in which the phone and the laptop reach the box with nothing but the Vyre
app and a QR code: no Tailscale, no port forwarding, no account with anyone.

[Paseo](https://github.com/getpaseo/paseo) (Apache 2.0) has shipped this for its daemon and
mobile app. We read its code closely, both to copy what works and to find what does not fit
Vyre's identity model.

## How Paseo does it

Paths are under `reference/paseo/` (Paseo at commit d7b7016).

- **Keys.** The daemon makes one Curve25519 keypair on first run and keeps it in
  `$PASEO_HOME/daemon-keypair.json` at 0600 (`packages/server/src/server/daemon-keypair.ts`).
- **The offer.** The pairing URL is `https://app.paseo.sh/#offer=<base64url JSON>`, carrying
  `{ v: 2, serverId, daemonPublicKeyB64, relay: { endpoint, useTls } }`
  (`packages/protocol/src/connection-offer.ts`, `packages/server/src/server/connection-offer.ts`).
  The offer sits in the fragment, so the web server never sees it. The QR is drawn in the
  terminal (`pairing-qr.ts`), and the app scans it with `expo-camera` (`packages/app/src/app/pair-scan.tsx`).
- **Handshake.** The client makes a fresh ephemeral keypair per connection, derives
  `nacl.box.before(daemonPub, clientEphSecret)`, and sends plaintext
  `{ type: "e2ee_hello", key }`. The daemon derives the same key and answers `e2ee_ready`.
  Every later frame is `[24-byte random nonce][XSalsa20-Poly1305 ciphertext]`, as base64 text
  or raw binary once both sides negotiate it (`packages/relay/src/crypto.ts`,
  `packages/relay/src/encrypted-channel.ts`). The daemon processes nothing until the hello
  arrives, and a repeated hello under a different key closes the socket.
- **Relay.** A Cloudflare Worker routes `/ws?serverId=&role=&v=2` to one Durable Object per
  `serverId` and uses WebSocket hibernation (`packages/relay/src/cloudflare-adapter.ts`,
  `wrangler.toml`). The daemon holds one outbound control socket (`role=server`). When a client
  connects, the DO sends `{ type: "connected", connectionId }` on the control socket and the
  daemon opens a data socket for that connection (`role=server&connectionId=`). Frames from a
  client that arrive before the daemon's data socket are buffered (200 at most). The daemon
  sends WebSocket protocol pings every 10 s, which Cloudflare answers at the edge without
  waking the DO (`packages/server/src/server/relay-transport.ts`).
- **Hosting moved.** The Worker now only proxies to `PASEO_RELAY_UPSTREAM` on Fly, and
  `docs/architecture.md` says production runs a separate Elixir service (getpaseo/paseo-relay,
  about 23,000 concurrent sockets) while the Cloudflare code "is retained as legacy code and is
  not deployed". The reason given is routing: frames stay inside one BEAM node. At our scale
  (one socket per box plus one per open device) the Durable Object version is the right size.
- **Admission.** A relay client that sends no password is admitted as the owner with full
  permissions (`packages/server/src/server/session-admission-auth.ts:21-26`,
  `COMPAT(relayPasswordOptional)`). The QR is the only credential.

### What Paseo leaves open, and Vyre cannot

1. **The QR is a permanent owner credential.** It holds only public data that never changes. Anyone who
   photographs it once, or finds it in a screenshot, can connect as the owner forever, and there
   is nothing to revoke short of rotating the daemon key and re-pairing every device. The client
   has no identity at all: its key is ephemeral, so the daemon cannot tell two phones apart.
2. **No replay or reflection protection inside a session.** Both directions use the same key
   and random nonces, and nothing counts messages. Paseo's `SECURITY.md` says in-session replay
   protection "is not yet implemented". A hostile relay can replay a client frame (run the
   same command twice), drop or reorder frames, or reflect a daemon frame back to the daemon,
   where it decrypts, because the key is the same both ways.
3. **No forward secrecy against the daemon key.** The session key is client-ephemeral times
   daemon-static. Whoever later steals `daemon-keypair.json` and recorded the traffic can decrypt
   all of it.
4. **The relay route is unauthenticated.** Anyone who knows a `serverId` can connect as
   `role=server`, and the DO closes the real daemon's control socket ("Replaced by new
   connection"). They cannot read anything, but they can take the daemon offline and receive
   every client's hello. Anyone can also open unbounded client connections, and the daemon
   opens a data socket and runs a handshake for each.
5. **Timers keep the DO awake.** `nudgeOrResetControlForConnection` uses `setTimeout`, which
   stops the object from hibernating while it runs.

## Decision

**The box connects outbound to a relay at `relay.vyre.run`. A device pairs by scanning a QR code
that carries the box's public key and a one-time secret. Every connection then runs a Noise IK
handshake in which both sides prove a long-term key. The box admits only devices it paired,
names each one `device:<id>`, and treats it as the owner on their own device, as it treats
`tailnet:<owner>` today. The relay forwards opaque frames and learns nothing but timing, sizes,
addresses and a route id.**

Both paths are optional and can run together. Tailscale stays the way to get Taildrive, SSH to
the box, exit nodes, guests from another tailnet and agent nodes (ADR 0014). The relay is the
default in onboarding, and Tailscale moves to "Advanced".

### 1. Keys on the box

In `~/.vyre/relay/` at 0600, made on first use, never leaving the box:

| Key | Type | Who sees the public half | Used for |
|---|---|---|---|
| `box.key` | X25519 | paired devices, through the QR | the Noise static key: devices check they reach this box |
| `route.key` | Ed25519 | the relay | proving to the relay that this box owns its route |

The route id is `base32(sha256(routePub))`, 26 characters. It is self-certifying: the relay needs
no account or database to know who may serve a route, only a signature. The two keys are
separate so the relay never holds anything that touches the end-to-end keys.

### 2. The relay

A Cloudflare Worker and one Durable Object per route id, at `relay.vyre.run`, in `relay/worker/`.

- **The box registers.** `GET /v1/box?route=<id>` upgrades to a WebSocket. The DO sends a random
  32-byte challenge. The box answers with `routePub` and an Ed25519 signature over
  `"vyre-relay-box-v1" || id || challenge`. The DO checks that `sha256(routePub)` is the id and that
  the signature verifies, and only then accepts the socket as the control socket. A second valid
  box socket replaces the first. An invalid one is closed and the real one stays. This closes
  Paseo gap 4.
- **Devices connect.** `GET /v1/device?route=<id>` upgrades with no credential. The relay cannot
  know devices, by design: the box admits them. The DO assigns a connection id, tells the box
  `{ t: "open", c }` on the control socket, and the box opens `GET /v1/box?route=&c=` as that
  connection's data socket (signed again, like the control socket). The DO then pipes frames
  between the two sockets without reading them.
- **Limits** (all in the DO, all counted, none timed): at most 8 device connections waiting for
  the box and 32 open per route, 64 buffered frames per waiting connection, frames of at most
  1 MiB (the channel chunks larger bodies), and a new device connection is refused with 1013
  when a route is over its limit. Per-address rate limiting uses Cloudflare's rate limiting
  binding in the Worker.
- **Hibernation.** Only `acceptWebSocket` and attachments, no `setTimeout`. Pings are WebSocket
  protocol pings, which Cloudflare answers at the edge. A dead control socket is found by the
  box's own ping (below), not by the DO.
- **What the relay stores.** Nothing durable. No logs of frame contents. Observability logs carry
  the route id, the event and the close code.
- **Self-hosting.** `relay/node/` is the same protocol in plain Node (`node:http` and the
  in-repo `core/computers/ws.js` framing, no dependencies). It is what the tests run against, and
  what someone who does not want our relay can run on any machine they reach. `relay.url` in
  config picks the relay.

### 3. The channel: Noise IK

`Noise_IK_25519_AESGCM_SHA256`, as in the Noise Protocol Framework (revision 34), with the
prologue `"vyre-relay-v1" || routeId`.

- IK fits exactly: the device (initiator) knows the box's static key in advance, from the QR,
  and the box learns the device's static key inside the first message, encrypted.
- It gives what Paseo lacks. Mutual authentication by long-term keys (gap 1). One key per
  direction with a counter nonce, so a replayed, reordered, dropped or reflected frame fails to
  decrypt and closes the channel (gap 2). An ephemeral-ephemeral DH, so a stolen `box.key` does
  not open recorded sessions (gap 3).
- **AES-256-GCM, not XSalsa20.** The box has no npm dependencies and `node:crypto` has
  X25519, AES-GCM, SHA-256 and HKDF but no XSalsa20. Counter nonces remove the one reason to
  prefer a 24-byte random nonce. The Expo app uses `@noble/curves`, `@noble/ciphers` and
  `@noble/hashes` (MIT, audited, pure JS), because Hermes has no WebCrypto X25519. A browser
  client can use WebCrypto.
- A session rekeys after 2^20 messages or 24 hours, and the channel closes at 2^32.
- The handshake payloads are JSON: the device sends `{ v: 1, device?: id, pair?: secret,
  name?, presenceKey? }`, the box answers `{ v: 1, box: { name, id }, device: id }` or closes
  with a reason. The box processes nothing from a connection before its first message
  decrypts and names a paired device or a live pairing secret.
- Paseo's handshake retry (resending hello every second) is not needed: the relay buffers the
  first message until the box's data socket opens.

### 4. What travels inside the channel

Multiplexed streams, so a phone can hold the event stream and make calls on one connection:

- `{ s, t: "req", method, path, headers }` then `body` chunks then `end`, from the device.
- `{ s, t: "res", status, headers }` then `body` chunks then `end`, from the box; `cancel` from
  either side.
- `{ s, t: "ws", path }` for `/v1/streams/<module>/<name>`, then binary frames both ways.

On the box, each stream becomes a real HTTP request: `http.request` with a `createConnection`
that returns one end of an in-memory duplex, and the other end handed to a private
`http.Server` whose handler calls `ctx.handler(policy)(req, res, caller, peer)`. Node's own
parsers handle the request, the SSE stream and upgrades, and the relay reuses every existing
route, the guest-style 404s and the same-origin checks, exactly as the names listener does.

### 5. Who a relayed device is

- **Caller `device:<id>`**, where `<id>` is the first 16 base32 characters of
  `sha256(devicePub)`. Only the relay listener can make it. `FORBIDDEN_LABEL` gains `device:`,
  so a socket client cannot claim it.
- **`meta.peer`** is `{ kind: "device", stableId: <id>, node: <device name>, login: null,
  tags: [], caps: {} }`. Presence sessions bind to `stableId` (ADR 0004), as they do for tailnet
  peers.
- **It counts as a person, and nothing else over the relay does.** One helper,
  `ownerDevice(caller)`, is true for `tailnet:<owner>` and for `device:*`. It replaces
  `ownerOverTailnet` in `callerAllowed`, in `registryRules`' person check, and at the prefix
  checks listed under Changed contracts (gate, link, files, federate, switchboard, memory,
  network, glass, onboard). A tool open to `deck` or `tailnet` is open to `device`.
- **No guests or agents over the relay** in this version. A guest needs someone else's identity,
  which Tailscale gives and the relay does not. An agent's computer stays behind the Gate and on
  its own tagged node.
- **Presence is unchanged.** Being a person lets a device ask. It never replaces the proof.
  HUMAN_ONLY tools and every `presence` tool still need `x-vyre-presence` inside the relayed
  request. The phone app uses the `device` method (ADR 0018: a P-256 key in the Secure
  Enclave or Android Keystore, released by biometrics), and its key is enrolled during
  pairing (below), so a relayed phone never needs a passkey. A passkey is bound to the address
  it was made at (`rp.id = location.hostname`), so a passkey from `<you>.vyre.run` does not work
  from a relay web client. A web client (later) would enroll its own under its own origin.
- **The floor rules do not move.** Floor rule 1 (the user sees the final words before anything
  goes out) is met by presence on the device, as on the tailnet. The PreToolUse floor also denies
  Bash that names `relay/box.key`, `route.key` or `devices.json`.

### 6. Pairing

`relay.pair.start` mints a pairing: a 16-byte secret, kept only as a hash, single use, gone after
10 minutes, and at most one live at a time. It returns the URL
`https://vyre.run/pair#<base64url {"v":1,"r":"relay.vyre.run","i":"<route id>","k":"<box pub>","s":"<secret>","n":"<box name>"}>`.
The fragment never reaches a server. The Deck and the onboarding page draw the QR with the
vendored `deck/vendor/qrcode.js`. The Capsule draws it too. `vyre relay pair` prints it in the
terminal.

The phone scans the code, makes its device static key (X25519, in the keychain) and its
presence key, and runs the handshake with `pair` set. The box checks the secret, burns it,
stores `{ id, name, pub, presenceKeyId, pairedAt }` in `relay_devices`, enrolls the presence key
as a `device` key, and shows "Alex's iPhone connected" on the screen that showed the code.

**Who may mint a pairing** is the security question, because a paired device is a person:

- **Normally, only a present person.** `relay.pair.start` is on the HUMAN_ONLY list. The Deck on
  the tailnet, a paired phone or the Capsule proves presence as for any approval.
- **The first device, during onboarding.** Before any person has a device (no tailnet owner and
  no paired device), the onboarding caller `onboard` may mint one pairing. This is the same trust
  as the claim link in ADR 0002, and it has the same weakness: a process running as the owner
  can ask the socket for an onboarding link. On a Mac the first pairing also needs `touchid`,
  which closes the gap there. On a Linux box it is detected, not prevented: the first-device
  slot is single, so if something else took it, the person's own phone is refused with "this
  box already has a device" and the page offers `vyre relay reset` (socket plus a terminal code),
  which removes every relay device. A code typed from the phone would not help, because a
  process that paired its own fake device knows that code too. Once a person exists, this path
  closes for good.

`relay.devices.list`, `relay.devices.rename` and `relay.devices.remove` (HUMAN_ONLY) manage
devices. Removal closes that device's live connections at once and removes its presence key.
Settings, Devices lists relay devices beside tailnet ones.

### 7. The box side

A new module, `relay`, in `core/relay/`:

- It is off until the first pairing, like Paseo's "relay disabled until pairing consent", and
  `relay.enable` / `relay.disable` switch it (presence).
- It holds one control socket to the relay, using Node's built-in `WebSocket` client. It sends
  a protocol ping every 60 s and reconnects when two go unanswered, with a backoff from 1 s to
  5 minutes. Nothing polls. When the relay says a device opened, it opens that connection's data
  socket.
- Events: `relay.connected`, `relay.disconnected`, `relay.device.paired`,
  `relay.device.removed`. Status: `relay.status`.

### 8. The clients

- **Phone (ADR 0027, one Expo codebase).** A `relay` transport beside the tailnet one, with the
  same API client on top: scan (`expo-camera`), keys in `expo-secure-store`, Noise over the
  platform `WebSocket`, then the stream multiplexer. The mobile team owns the app. This team
  ships the transport as one TypeScript file with its tests (`relay/client/`) that the app
  imports.
- **Laptop.** On the Mac, vyred is already a client of the box (`network.box`, `core/link`). The
  relay adds a second transport for the link: the Mac pairs like a phone, with `touchid` as its
  presence, and the Deck and the Capsule on the Mac keep talking to the Mac's own vyred as they
  do now.
- **A browser with no Vyre installed** (a borrowed laptop) is later work. It needs the web
  build served from a public origin, and whoever serves that code could read the session. Paseo
  accepts this for `app.paseo.sh`. We would want the build pinned by hash first.

### 9. Onboarding

The devices step shows "Connect with a QR code" first: one code that the Vyre app scans. The
same card links to the App Store and Play for people without the app. Tailscale moves under
"Advanced: reach the box over your own tailnet", with today's steps unchanged. `vyre up` on a
headless box prints the QR in the terminal.

## Threat model

| Who | What they can do | What stops them |
|---|---|---|
| The relay operator, or someone who owns the relay | see IPs, timing, sizes, the route id; drop, delay, replay or reorder frames; take a route offline | Noise: they hold no key, and every change fails to decrypt and closes the channel. Availability is the one thing they control, and Tailscale remains as a fallback |
| Someone who knows a route id | open device connections to it | the box admits only paired devices; the relay caps waiting and open connections per route and rate-limits addresses |
| Someone who photographs a QR code | pair once, within 10 minutes, if the owner has not scanned it first | single use, 10 minutes, and the box shows every new device on the screen where the code was shown; removal is one tap |
| Someone who steals a paired phone | act as a person, but not pass presence | the presence key needs the phone's biometric; the owner removes the device from any other one |
| A process on the box, running as the owner (Claude's shell) | read `~/.vyre/relay/`, impersonate the box to devices, call the socket | ADR 0002 already puts root and the owner's Unix account's files out of scope for secrecy; the floor denies Bash naming the key files; minting a pairing needs presence; presence needs a device's biometric |
| A stolen `box.key` later | nothing against recorded traffic | the ee DH gives forward secrecy |
| A malicious web page in the owner's phone browser | nothing | the relay client is the native app, not a browser origin |

Residual risks, stated: the first-device path during onboarding (section 6), availability of the
one hosted relay, and traffic analysis by the relay.

## Cost

Cloudflare's Durable Objects pricing (checked 27 Sep 2026): the free plan gives 100,000 requests
and 13,000 GB-s a day; Workers Paid ($5 a month) gives 1 million requests and 400,000 GB-s a
month, then $0.15 per million requests and $12.50 per million GB-s. Incoming WebSocket messages
count 20 to 1, protocol pings are free, and a hibernating object is not billed for duration.

- An idle box costs nothing: its socket hibernates and its pings are free.
- A heavy user (two hours a day streaming, 50 frames a second into the DO) is about 18,000
  requests and 900 GB-s a day, about $0.40 a month on Workers Paid.
- Recommendation: start on the free plan for testing; move to Workers Paid before any public
  launch, since the free plan's daily cap would cover only a handful of heavy users.

## Consequences

- One service that Vyre AI runs and everyone depends on for this path, beside the planned
  name directory (ADR 0002). It holds no data, and anyone can run `relay/node/` instead.
- One more caller class, `device:*`, and one helper that every "is this the owner on a device"
  check must use. Getting a check wrong could let a device do less than it should. It cannot let
  a device skip presence, because presence does not read the caller.
- The box learns to be reachable with no Tailscale at all, so a person can finish onboarding
  with only the Vyre app on their phone.

## Licence

Code adapted from Paseo keeps Paseo's copyright and licence header and a "Modified for Vyre"
line, and `NOTICE` says: "Portions derived from Paseo, Copyright (c) 2025-present Mohamed Boudra,
Apache License 2.0". The files we draw from (`packages/relay/src/*`,
`packages/server/src/server/relay-transport.ts`, `pairing-offer.ts`, `connection-offer.ts`,
`packages/protocol/src/connection-offer.ts`) are Paseo's own. None is a third-party component
under another licence.
