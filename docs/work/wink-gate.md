# wink-gate

## Scope
Close the security review items on Wink pairing (team/0.3/reviews/wink-pairing.md, wink-regate.md): W-3, W-3b, W-4, W-5, W-7, W-8, the node-key claim hijack and W-9. Branch work/wink-gate off work/wink. Nothing in kernel/.

## Done
- W-3, W-3b: core/relay/bridge.js releases the peer slot on every exit; allow(deviceId).
- W-4: wink.server.adopt: first caller recorded for every kind, presence (when an owner exists) plus the adopter or a local screen for any change.
- W-5: one store, the kernel's. pairing takes the `offers` port (kernel/remote/offers-port.js, `ctx.kernel.offersPort()` in index.js); no copy is kept (the migrations drop wink_compute); with no port compute offers say "no kernel". Tests run the real offers port over a fake grants.offers.
- W-7: devices.add upsert refuses identity, kind and owner changes; setSelf is the adopt path.
- W-8: relay.devices.drop only for module:wink.
- Node-key claim: only the key the host reports as proven binds (admitPeer passes it to serve); claims lapse after 60 s.

## Doing
Nothing.

## Next
The merged branch work/wink-merged (v0.3 + wink-gate + tailnet's work/wink 1bd3e5823) goes to reviewer-3 for the gate and to the integrator.

## Needs
- W-9: no PAKE library for Node suits as a drop-in. CPace packages (cpace-ts 0.1.4, @cipherman/pake-js 0.1.1) are one-person, unreviewed. The reviewed options are OPAQUE (@cloudflare/opaque-ts, @serenity-kit/opaque), an asymmetric PAKE: the showing device would register the code against itself and the typist log in, which changes the message flow in relay/client/code.js, join.js and the relay's code rendezvous. Owned by tailnet now.

## Changing a server's owner (W-4 consequence)
Once a server has an owner, `wink.server.adopt` cannot be repeated over the paired channel: that call carries no presence proof. To change who a server belongs to, the person works on the box itself (a local screen or the CLI, `vyre call wink.server.adopt` with the new owner) and approves with their own presence (passkey or Touch ID). A paired device other than the one that first adopted it is refused even with presence. The screen and the CLI should say: "This server already belongs to <owner>. To move it, do it on this server and approve with your passkey."

## The three-way merge (work/wink-merged)
Base origin/work/v0.3 (which already holds work/wink-gate d6c31f7f9 and platform's offersPort), then origin/work/wink 1bd3e5823. Gate items kept as reviewed; tailnet's version kept only where it does more:

- core/relay/index.js, relay.devices.drop: tailnet's body (caller check plus the device must be paired and not removed, else not_found). It does the same caller check and one more thing. My W-8 test now expects not_found for an unknown device under module:wink.
- core/wink/pairing.js, `setSelf` and `setSignKey`: tailnet's. setSelf is an upsert that keeps the self row's sign_key and node binding (mine replaced the whole row); setSignKey serves wink.relay.apply. `devices.add` stays mine, with tailnet's refusal codes and words ("denied", "already has an owner") because the pairing card reads them.
- `wink.server.adopt`: mine (presence for any change, first caller recorded), extended with tailnet's: adoptInput with owner name and handover, applyAdopt storing the handover, "the same owner named again changes nothing", the plain serverOwned words, `wink.server.handover`, `wink.server.retarget`. Not kept: tailnet's "directory says the identity administers the space, so a change is allowed" rule, because the identity is caller-supplied (a paired device could name an admin). retarget now also refuses a paired device other than the adopter. A refusal without presence is `presence_required` with the serverOwned words.
- Node-key claim: mine (a noted, unexpired claim for the key the host proved binds; an unnoted proven key binds nothing). Tailnet's host passes { nodeKey, stableId }; the stable id is used when the note has none. Tailnet's test "an expired note still binds the proven key" now expects no binding; its hijack test notes the real key first.
- W-3, W-3b (bridge.js): mine (accessor-wrapped onend/onreset plus wrapped end/reset). Both sets of tests stay.
- W-5: platform's `offersPort()` wiring is the only path. Tailnet's gateway-shape port (offer/unoffer/active with chainFor) is gone, and so is the local fallback; its tests now run the real offers port over their fake grants.offers. Personal-space compute needs no kernel (tailnet's rule), a space this home does not host is `unavailable`.
- core/wink/node/peer-wire.js: tailnet's (the host passes the proof; my extra argument there was redundant).
- Kept whole, tailnet only: relay.apply, the bridge and storage transport, failed adopt failing the pairing, the 5 s direct-path liveness fallback, space names on cards, the installer changes, the kernel-pair script, peer-cache.
