# wink-gate

## Scope
Close the security review items on Wink pairing (team/0.3/reviews/wink-pairing.md, wink-regate.md): W-3, W-3b, W-4, W-5, W-7, W-8, the node-key claim hijack and W-9. Branch work/wink-gate off work/wink. Nothing in kernel/.

## Done
- W-3, W-3b: core/relay/bridge.js releases the peer slot on every exit; allow(deviceId).
- W-4: wink.server.adopt: first caller recorded for every kind, presence (when an owner exists) plus the adopter or a local screen for any change.
- W-5: pairing takes an `offers` port; with it wink_compute is never read or written. Without one wink_compute is the only store.
- W-7: devices.add upsert refuses identity, kind and owner changes; setSelf is the adopt path.
- W-8: relay.devices.drop only for module:wink.
- Node-key claim: only the key the host reports as proven binds (admitPeer passes it to serve); claims lapse after 60 s.

## Doing
Nothing.

## Next
W-9 waits for team-lead (see Needs).

## Needs
- W-9: no PAKE library for Node suits as a drop-in. CPace packages (cpace-ts 0.1.4, @cipherman/pake-js 0.1.1) are one-person, unreviewed. The reviewed options are OPAQUE (@cloudflare/opaque-ts, @serenity-kit/opaque), an asymmetric PAKE: the showing device would register the code against itself and the typist log in, which changes the message flow in relay/client/code.js, join.js and the relay's code rendezvous. Decision needed from team-lead.
- W-5: platform to write the kernel adapter for the `offers` port (get/set over grants.offers with a chain and presence); the seam is in core/wink/pairing.js.

## Changing a server's owner (W-4 consequence)
Once a server has an owner, `wink.server.adopt` cannot be repeated over the paired channel: that call carries no presence proof. To change who a server belongs to, the person works on the box itself (a local screen or the CLI, `vyre call wink.server.adopt` with the new owner) and approves with their own presence (passkey or Touch ID). A paired device other than the one that first adopted it is refused even with presence. The screen and the CLI should say: "This server already belongs to <owner>. To move it, do it on this server and approve with your passkey."

## Retired
work/wink-merged (c0cae209c) is retired: reviewer-3 passed tailnet's origin/work/wink at 0b317fe15, which holds these fixes. The N-1 and N-2 tests go in through work/wink-fix 57df6b52b. Nothing more is pushed from this team.
