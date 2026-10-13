---
title: Identity and devices
summary: How a person's name, the devices that speak for it, pairing, sign in by name, recovery and GitHub sign-in work.
audience: builders, agents
owner: docs
status: stable
---

# Identity and devices

## What it is

A person is a permanent identity id plus a signed, chained list of the keys that may speak for it, published under a name such as `alex.vyre.run`. Devices join that list by pairing or by approval from a device already on it, and the list can be recovered with a recovery code.

## What a person sees

- First run, "Sign in to Vyre", with the lead "Your name is how Vyre knows you on every device." Choices: "I already have a name" ("Sign in on this device. You approve it from a device you already use.") and "I am new to Vyre" ("Pick a name and save your recovery kit.").
- Sign in by name: the screen "Approve on your other device". The other device asks "Sign in on this device", shows three words, and the person checks they match and taps Approve. A secondary button reads "Use my recovery kit instead". Refusals are in plain words: nobody approved in 2 minutes, the other device said no, too many requests for that name.
- Sign in with GitHub is offered on the same first screen (`apps/app/screens/onboard/IdentityScreens.tsx`, `real-github`).
- Settings, Devices: title "Devices", sub line "Each device joins each space on its own.", button **Add a device**, and a switch **Make it faster** (direct connections between your devices). Each row shows a mark, the name, a kind (Phone, Server or Computer), the last time seen and the spaces it reaches.
- One device page: "Share this computer" (**Allow with Face ID**, **Stop sharing**), per-space **Add**, and a "Remove" group. A removed device shows "That device is not here".
- Marks: every person, device and space has a generated mark from a seed, so the same name draws the same picture on every screen (`apps/app/ui/marks/source.js`). A device mark also carries its kind.

## How it works

**The identity chain** (`kernel/identity/chain.js`, run unchanged by the app, every home and the directory Worker). The id is a kind prefix plus the hash of the genesis body, so nobody can claim another's id. Ops: `genesis`, `add`, `remove`, `replace-code`, `recover`, `agree`. Each op is signed by an entry already on the list. The list holds device keys, one recovery-code key and optional recovery contacts.

**Newcomer rule.** For its first 24 hours an entry can sign but cannot remove older entries or touch a code or contact. Any older entry can remove a newcomer at once.

**Web keys are marked.** An entry with `held: "web"` is a key a script on a web origin can reach. It may sign its own genesis and nothing else about the list. Who speaks for a name changes only by a passkey entry, a phone or computer device key, or the recovery code. A device entry may carry an `enclave` key (the phone's Secure Enclave), and then every list change it signs must carry `esig`, or the op is refused as `needs_enclave`.

**Directory.** The name directory (`names/`, `core/names/`, client `lib/identity/directory.js`) stores the chain; a name belongs to an identity or a Space, never to a server. Emitted: `name.claimed`, `name.moved`, `name.released`.

**Pairing.** `wink.phone.open` shows a code on the device that holds the name; the new device redeems it over the relay (`relay/client/phonepair.js`) and, on the person's yes, the holding device writes the new key onto the chain. The new device keeps the name only after it reads the list and finds its own key (`apps/app/src/identity/add-device.ts`: errors `bad_code`, `taken`, `denied`, `expired`, `not_enrolled`, `not_listed`). Servers pair through `wink.pair.server`, `wink.server.code`, `wink.server.confirm`. Events include `wink.code-opened`, `wink.pair-done`, `wink.signin-asked`, `wink.enrolled`, `wink.pair-failed`.

**Sign in by name.** The new device asks the relay for the name; the server holding that identity hears `relay.signin-asked` (`core/wink/index.js`), and a device already on the list is asked to approve under a presence proof (`kernel/remote/proof.js`).

**Terminal sign-in.** `signin.ask` asks the owner's phone; `signin.answer` takes the yes with a presence proof; the terminal then holds a person session until it signs out or goes unused for 30 days (`core/signin/module.json`).

**Recovery.** A recovery code is 128 random bits written as 26 base32 characters (`core/spaces/recovery.js`). An optional password of at least 8 characters is stretched together with it by Argon2id (`kernel/identity/stretch.js`). The code only adds a device, and that device is a newcomer for 24 hours. Tools: `spaces.identity.recover.code`, `.recover.begin`, `.recover.approve`, `.recover.finish`, `spaces.identity.code.replace`, `spaces.identity.contact.key`.

**GitHub sign-in** (`relay/worker/github.js`, `escrow/worker/index.js`). GitHub proves who a person is and nothing else: no scope, token revoked within the callback and never stored. A link binds one numeric GitHub id to one identity id, and the link request must be signed by a non-newcomer device entry on the chain. The escrow Worker keeps the sealed vault Secret Key plus a per-link key as a relay entry on the chain; it never sees the master password or recovery code, so the vault stays shut without the password. Separately, `core/github/connect.js` signs the box in to GitHub through the real `gh` CLI for repos; that is a vault token, not an identity.

**Device lists and removal.** `spaces.identity.entries`, `spaces.identity.entry.add`, `spaces.identity.entry.remove`, `spaces.devices.list`, `spaces.devices.remove`, `spaces.devices.restore`, `spaces.devices.lend`. A removed phone wipes its local keys (`apps/app/src/identity/device-wipe.*.ts`). Events: `identity.device-removed`, `space.device-removed`, `space.device-lent`, `identity.recovered`.

**Kernel checks.** Almost every tool above has reach `person`: it runs under the caller's own chain, and changes to the list or a device need a presence proof, never a model's word. The private key stays in files at mode 0600 or in the OS key store and is never logged or returned. The recovery code is returned once, at creation.

## Where the code lives

- `kernel/identity/`: chain, stretch, pinned vectors (`PINNED.json`, `agree-vector.json`).
- `core/spaces/identity*.js`, `core/spaces/recovery.js`, `core/spaces/presence-signer.js`: identity tools and recovery.
- `core/wink/`: pairing, codes, server adoption, sign-in asks.
- `core/signin/`: terminal sign-in.
- `relay/client/`, `relay/worker/`: relay pairing client and the GitHub link Worker.
- `escrow/worker/`: GitHub sign-in escrow.
- `names/`, `core/names/`: name directory and serving.
- `apps/app/src/identity/`, `apps/app/screens/devices/`, `apps/app/screens/onboard/`: device keys, add-device, screens.

## How agents use it

- Reads such as `spaces.identity.status` and `spaces.devices.list` are person-reach tools; an agent gets them only when the person's rules open them.
- Every write above, including recovery, pairing, device removal and sign-in answers, is person only and needs the person's presence. No model can approve a sign-in or add a key.
- See [presence](../../concepts/presence.md) and authority (agent doc "authority").

## Limits today

- Nothing has been walked on a real iPhone or Android yet, including Face ID pairing and the removed-phone wipe.
- Windows Hello has not been walked on a real PC. A Windows PC without Hello keeps a key marked as reachable by a page script, so it cannot change who speaks for your name.
- Direct paths through a home router are unproven; the relay carries the connection.

## Related

- [Spaces and members](./spaces-and-members.md), [Kernel](./kernel.md), [Relay and networking](./relay-and-networking.md), [Vault](./vault.md), [Gate](./gate.md)
- [Architecture map](../map.md), [Overview](../overview.md)
- [Presence](../../concepts/presence.md), [Your private network](../../concepts/network.md), [Windows](../../using/windows.md), [Known gaps](../../known-gaps.md)
