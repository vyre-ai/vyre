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
