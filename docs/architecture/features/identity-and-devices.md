---
title: Identity and devices
summary: How a person's name, the devices that speak for it, pairing, sign in by name, recovery and GitHub sign-in work.
audience: builders, agents
owner: docs
status: stable
---

# Identity and devices

## What it is

A person is a permanent identity id plus a signed, chained list of the keys that may speak for it. The list is published under a name such as `alex.vyre.run`. A device joins the list by pairing or by approval from a device already on it. A recovery code can rebuild access to the list.

## What a person sees

- First run shows "Sign in to Vyre" with the lead "Your name is how Vyre knows you on every device." The choices are "I already have a name" ("Sign in on this device. You approve it from a device you already use.") and "I am new to Vyre" ("Pick a name and save your recovery kit.").
- Sign in by name opens "Approve on your other device". The other device asks "Sign in on this device" and shows three words. The person checks they match and taps Approve. A second button reads "Use my recovery kit instead". Refusals come in plain words: nobody approved in 2 minutes, the other device said no, or too many requests for that name.
- First run is Identity, a space, then Ready, on the web and in both apps (`apps/app/screens/first-run/FirstRun.tsx`). GitHub is optional on the identity screen and does not unlock the vault.
- Settings, Devices has the sub line "Each device joins each space on its own.", the button **Add a device** and a switch **Make it faster** for direct connections between your devices. Each row shows a mark, the name, a kind (Phone, Server or Computer), the last time seen and the spaces it reaches.
- A device page offers "Share this computer" (**Allow with Face ID**, **Stop sharing**), a per-space **Add** and a "Remove" group. A removed device shows "That device is not here".
- Every person, device and space has a generated mark drawn from a seed, so one name draws one picture on every screen (`apps/app/ui/marks/source.js`). A device mark also shows its kind.

## How it works

**The identity chain** (`kernel/identity/chain.js`, run unchanged by the app, every home and the directory Worker). The id is a kind prefix plus the hash of the genesis body, so nobody can claim another person's id. The ops are genesis, add, remove, replace-code, recover and agree. An entry already on the list signs each op. The list holds device keys, one recovery-code key and optional recovery contacts.

**Newcomer rule.** For its first 24 hours an entry can sign but cannot remove older entries or touch a code or contact. Any older entry can remove a newcomer at once.

**Web keys are marked.** An entry with `held: "web"` is a key a script on a web origin can reach. It may sign its own genesis and nothing else about the list. Only a passkey entry, a phone or computer device key, or the recovery code can change who speaks for a name. A device entry may carry an `enclave` key (the phone's Secure Enclave). Every list change that device signs then needs `esig`, or the op is refused as `needs_enclave`.

**Directory.** The name directory (`names/`, `core/names/`, client `lib/identity/directory.js`) stores the chain. A name belongs to an identity or a Space, and never to a server. It emits name.claimed, name.moved and name.released.

**Pairing.** `wink.phone.open` shows a code on the device that holds the name. The new device redeems it over the relay (`relay/client/phonepair.js`), and on the person's yes the holding device writes the new key onto the chain. The new device keeps the name only after it reads the list and finds its own key (`apps/app/src/identity/add-device.ts`; errors `bad_code`, `taken`, `denied`, `expired`, `not_enrolled`, `not_listed`). Servers pair through `wink.pair.server`, `wink.server.code` and `wink.server.confirm`. Events include wink.code-opened, wink.pair-done, wink.signin-asked, wink.enrolled and wink.pair-failed.

**Sign in by name.** The new device asks the relay for the name. The server holding that identity hears relay.signin-asked (`core/wink/index.js`), and a device already on the list is asked to approve under a presence proof (`kernel/remote/proof.js`).

**Terminal sign-in.** `signin.ask` asks the owner's phone and `signin.answer` takes the yes with a presence proof. The terminal then holds a person session until it signs out or sits unused for 30 days (`core/signin/module.json`).

**Recovery.** A recovery code is 128 random bits written as 26 base32 characters (`core/spaces/recovery.js`). An optional password of at least 8 characters is stretched together with it by Argon2id (`kernel/identity/stretch.js`). The code adds a device and does nothing else, and that device is a newcomer for 24 hours. The tools are `spaces.identity.recover.code`, `.recover.begin`, `.recover.approve`, `.recover.finish`, `spaces.identity.code.replace` and `spaces.identity.contact.key`.

**GitHub sign-in** (`relay/worker/github.js`, `escrow/worker/index.js`). GitHub proves who a person is and nothing more: no scope, and the token is revoked within the callback and never stored. A link binds one numeric GitHub id to one identity id, and a device entry older than the newcomer window must sign the link request. The escrow Worker keeps the sealed vault Secret Key and a per-link key as a relay entry on the chain. It never sees the master password or recovery code, so the vault stays shut without the password. Separately, `core/github/connect.js` signs the box in to GitHub through the real `gh` CLI for repos. That is a vault token, not an identity.

**Device lists and removal.** `spaces.identity.entries`, `spaces.identity.entry.add`, `spaces.identity.entry.remove`, `spaces.devices.list`, `spaces.devices.remove`, `spaces.devices.restore` and `spaces.devices.lend`. A removed phone wipes its local keys (`apps/app/src/identity/device-wipe.*.ts`). Events: identity.device-removed, space.device-removed, space.device-lent and identity.recovered.

**Kernel checks.** Almost every tool above has reach `person`. It runs under the caller's own chain, and a change to the list or a device needs a presence proof, never a model's word. The private key stays in files at mode 0600 or in the OS key store, and nothing logs or returns it. The recovery code is returned once, at creation.

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

- `spaces.identity.status` and `spaces.devices.list` have reach `person`. An agent gets them when the person's rules open them.
- Every write above is person only and needs the person's presence: recovery, pairing, device removal and sign-in answers. No model can approve a sign-in or add a key.
- See [presence](../../concepts/presence.md) and authority (agent doc "authority").

## Extend it

In 0.5 Face ID pairing and the removed-phone wipe have run in tests and have not been walked on a real iPhone or Android phone. Windows Hello has passed its tests with a stand-in authenticator and has not run on a PC with Hello set up. A Windows PC without Hello keeps a key marked as reachable by a page script. That key cannot change who speaks for your name, so list changes come from a phone or the recovery code. A direct path through a home router has not been tried, and the relay carries the connection until one exists.

A business that wants its own step around sign-in or devices builds a custom module that reads the contracts in `kernel/contracts/`. [How to extend Vyre](../../../ARCHITECTURE.md#how-to-extend-vyre) covers modules and Integrations for outside apps. Open items: [known gaps](../../known-gaps.md).

## Related

- [Spaces and members](./spaces-and-members.md), [Kernel](./kernel.md), [Relay and networking](./relay-and-networking.md), [Vault](./vault.md), [Gate](./gate.md)
- [Architecture map](../map.md), [Overview](../overview.md)
- [Presence](../../concepts/presence.md), [Your private network](../../concepts/network.md), [Windows](../../using/windows.md), [Known gaps](../../known-gaps.md)
