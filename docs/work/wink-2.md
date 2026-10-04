# wink-2: device-first pairing leaves the device usable

Branch work/wink-session, off origin/work/devbox. Owner: wink-2 (took this one job from tailnet).

## Scope
After the three words are picked at the server in device-first pairing, the device had no person session and no peer session. Now:
- A. Server: the pick records the device as the owner's (kind phone, computer or web; key; key_storage), enrols its own presence key by the pick (`presence.device.enroll-paired`, relay only, gated server ticket only), makes the pair-grant, makes the claimed identity the home's owner (`spaces.owner.adopt`) and enrols the device in the home space (explicit list, `spaces.devices.enrolled`).
- B. Device: `core/wink/serverlink.js`. `wink.sessionFor(serverId)` -> `{ call(tool, input), close() }` (a Wink peer stream `{ peer: "wink", space: "home" }` on the paired relay channel, reopened after a drop), `wink.remoteKernel(serverId, space)` (the kernel's own remote client over it), `wink.startPaired(serverId)` (pair-challenge then start-paired, needs a `signDevice` seam).
- Home: `core/daemon/peer-door.js` composes the relay peer door, which no daemon had wired. The device is asked of the relay on every call. A call runs as `device:<id>` with the facts the daemon builds (PH-1) and the device's own live paired session as the person session; `kernel.call` goes through `withKernelCall` to the Space's `createRemoteServer`; an owner proof rides `input.proof` and reaches the kernel as `meta.kernel_proof`.

## Done
Unit: core/wink/pairing.test.js (3 new). Real daemon, relay, presence and kernel: test/wink.test.js, three "device-first" tests (recorded, granted, enrolled, start-paired, records.me over the peer session answers the owner, grants.members.list over the remote kernel; removed device refused at its next call; replayed start-paired refused; web device has no device-key session and no person over the peer stream).

## Needs from others
- windows: `spaces.host-here` and `spaces.retire-here` must declare callers that admit a paired device (`device`) or they are refused; their `hooks.sessionFor` is `wink.sessionFor` (a non-tool on the wink module, passed by the composition root).
- chat: the app is box-less on a phone, so it cannot run peer-wire (node:crypto, Buffer); it needs a browser-safe peer framing or calls the server's tools over its relay connection. Not built here.
- reviewer-2: the claimed identity becomes the home's kernel owner at the pick (spaces.owner.adopt), proof-free by ruling 1. Please gate.

## Changed contracts
- `wink.server.adopt` input gains `device: { kind: phone | computer | web, name }`; `relay.pair.pending.confirm` gains `pick`; new internal tool `presence.device.enroll-paired`; `KINDS` gains `web`; `streamPipe` hands Buffers.

## The owner rule (lead, 4 Oct)
- Becoming a home's owner always needs the identity proof: the app's identity key signs `vyre-wink-pair-to-v1`, this pairing's box and device; the server reads the claimed Vyre name's chain from the names directory (`spaces.identity.lookup`, pinned and verified, kept only when it is that id's) and checks the signature. The three words confirm the DEVICE to the person at the server; the proof confirms the IDENTITY to the server. A missing proof, another identity's, and a directory out of reach each refuse in their own words (no "waiting to pair to" on a server with no pair-to) and own nothing. `spaces.owner.adopt` runs only on a verified proof.
- First pairing of a server with no owner: the grant needs no presence (nobody can give any yet); the paired session is bound to the device's own presence key, else to the pairing itself. Any later device on an owned server goes through the owner's presence (`wink.server.adopt` refuses without it; the phone and computer flows ask the owner). `wink.server.pair.answer` is the box's own CLI only (Q-2).
- The adopt answer carries `session: false` when the device record or grant failed.

## What each device kind gets (G-1)
- phone, computer, web: a row in wink_devices as the owner's device, a paired session (person session for that one device, bound to the key it offered; hardware is never believed from the app's word), and a Wink peer stream to this home's door as `device:<id>`.
- Compute offers, storage and node-peer admission are not granted by kind: compute needs the owner's offer and the space's, storage and server peers are servers and storage devices only (`peers.allow` answers only for a server). Test: core/wink/pairing.test.js "G-1".

## Presence over the peer wire (lead ruling, 4 Oct)
kernel/remote carries it in one place (wire.js, server.js, client.js). A kernel call that needs presence is asked with no proof; the home answers `needs_presence` with `error.challenge` ({ call, space, home, nonce, expires, args_hash, and op, fields, payload_hash for a call a presence proof covers }). The device signs it with its own presence key (the client's `signer`) and resends the same call with `proof` and `challenge` (the nonce) beside the args; if the caller's own options object held other options, `opts` is its index. The home spends the nonce (live, its own, for this device, call and arguments, used once, spent even when the kernel then refuses) and passes the proof to the kernel as the trailing `{ presence }` option; the kernel's verifier checks the key, the role and the hash. The peer session alone never counts and the server never signs. Test: kernel/remote/presence.test.js. Open: the kernel check (platform) and the signer (native-core, app-wire); PD-1 and PD-2 are in core/daemon/peer-door.js.

## Session renewal (lead ruling, 4 Oct)
A paired session is renewed, not re-paired. (a) A device that lapsed and still holds the key the owner confirmed at pairing calls `presence.person.pair-challenge`; the server makes the one-use grant itself from wink's pairing record (confirmed by the owner, a key on it, not removed) and the device answers with `presence.person.start-paired`, signing `paired-start\n<device>\n<challenge>` with its key. No owner step. `wink.sessionFor(...).call` does this by itself. (b) Three wrong answers lock the device for fifteen minutes; the owner lifts it from their own device with `presence.person.renew-allow { device }` (their presence), and the device stays paired and waiting. A device with no key on its record (it offered none in its hello) cannot hold a paired session at all, so there is nothing for an owner approval to bind a session to; core/approvals' kernel-proof ops do not cover it. (c) A removed device has its key cleared, so renewal is refused: re-pairing is for it alone.

## Presence strength over the wire (lead ruling on PW-1 to PW-5, 4 Oct)
- No client signs a presence challenge by itself with a key that needs no person. The automatic signer in `wink.sessionFor` (`autoPresence`) exists only on a development build behind the dev switch `VYRE_SEAL_SOFTWARE=1` (the software signer's switch) in the first machine's daemon environment; without it a `presence_required` reaches the caller unchanged.
- host-here on a dev-kind pair: set `VYRE_SEAL_SOFTWARE=1` on the first machine's daemon; `spaces.create` with the server as home then signs host-here's tool proof (tool `spaces.host-here`, input `{ name, id? }`) with the computer's device key, which the server enrolled at pairing. RC1 accepts the registry's tool-proof for host-here (the kernel does not gate it); a kernel op for hosting a space, so the proof is kernel-checked with the nested hash like grants.*, is the right end state and is NOT DONE (platform, after HA-1 and the rehearsal).
- The server rule (a release-kind server accepts a presence proof only from a key it enrolled as hardware) is vault's and platform's: the verifier and the registry's presence option. Not mine, not done here.
- PW-2: the remote client checks a challenge (call, space, hash of the arguments it sent, home when known, and op/fields/payload_hash for a grants call) before signing. PW-3: 8 live challenges per device. PW-4: only a proof and its challenge travel as options, and the server appends the proof as its own trailing option. PW-5: sign-in is triggered by the code `person_session_required`, at most 3 a minute per server.


## PS-A and pairing, 4 Oct (after the restart)
- `stream.open-peer` re-asks access before every batch of frames (one ask serves every frame queued while it ran); a refusal ends the stream with `access_ended`; roles refresh from the re-check. A reset frame is flushed before the close. core/stream/peer-open.test.js (4), test/wink.test.js (web software session, ninth open).
- A computer's pairing sends `owner.pin` (identityPin seam, from `spaces.identity.self`).
- Open: walker's pairing hang. `wink.pair.server` steps are bounded at 20 s and named; the stuck step is not known until walker's fresh-homes rerun names it.

## Next (paused by the lead, 4 Oct)
- Full test/wink.test.js run on 59678f38e was still going on testbox4 (/tmp/w2-d.out); read its summary first. Everything else on 59678f38e passed: core/stream, daemon-smoke, kernel/boot, peer-door (203 pass, 0 fail), pairing.test.js 80/80.
- Pairing hang: walker could not reproduce it on a fresh state (trunk 6368a11c0), so it was leftover state in the old first-machine home or specific to spaces 1f9b1945f. Nothing to fix until windows names a branch where it recurs.
- Review the stream half of tailnet's merge of wink-rc1 with devbox 9f7e91594 in core/daemon/peer-door.js (dispatchFor(peerStream), openByDevice, watchers, events.on must survive next to the invitee block).
