---
title: "ADR 0054: Master password and the space vault"
summary: One master password unlocks a person's identity and personal vault. Each space has its own vault key, wrapped to every member and to the server, so lending keeps working when nobody is online.
audience: builders
owner: platform
status: draft
---

# ADR 0054: Master password and the space vault

Status: accepted, 15 Oct 2026 · Workstream: identity · Supersedes the affected parts of ADR 0001 (the personal keystore) and ADR 0051 (what the recovery code opens).

## Context

A person has one username, one master password and one recovery key. The personal vault already lends a credential into a request at the moment of use, and the caller receives the result, never the value. That lending has to keep working for the box's own agents and for an external agent on MCP, including when no person is unlocked. A space also needs a vault its members share, which must stop working for someone who was removed.

## Decision

1. **The person address is `https://vyre.run/u/<name>`.** It is private by default. `<name>.vyre.run` answers 301 to that URL, except the infrastructure hosts (`names`, `app`, `api`, `www`, `relay`, `acme`, `mail`, `docs`, `status`). Each space keeps its own server URL.
2. **One master password.** Argon2id in `kernel/identity/stretch.js` (one lane; production memory 65536 KiB, 3 passes, 32-byte tag) unwraps a random root key. That root key wraps the identity signing key, the agreement key and a copy of the personal vault key. The password is entered on the person's device. A model caller that supplies `password`, `recovery` or `recoveryKey` is refused (`secret_refused`).
3. **One recovery key, shown once.** `kernel/identity/code.js` is the only generator (128 bits, 26 base32 characters). The same key is the chain code entry from `spaces.identity.create` (called with an empty chain password, so the existing code-key mechanism is unchanged) and the HKDF wrap of the root key. This supersedes the comfort in ADR 0051 that the recovery code is only a directory key: on a device that holds the master record, the recovery key opens the identity and the wrapped personal vault key. The chain's newcomer rule for later devices is unchanged. A migration cannot read the old code, because it was never stored, so `identity.migrate` shows a new recovery key once and leaves the old chain entry in place.
4. **GitHub links the username and does not unlock the vault.** `identity.github.link` stores the login and subject. Signing in on another computer is the space server URL plus the username and the master password, or that GitHub link plus the master password (`devices.signin`). The tool records the server and returns wrapped material for the pairing workstream. It does not dial.
5. **The master password is the root of the personal vault.** When this process has unwrapped the master record, `currentPersonalKey()` is the device key `Vault` adopts (`core/vault/master-root.js`). `vault/key` is the server-held copy of that same key. When the held key opens the agent vault and the file differs, the file is rewritten from the held key. With nobody unlocked, that copy still opens the agent vault, so lending does not wait. A home with no master record keeps the file or keychain keystore. A master record with neither a held key nor a server copy does not invent a new key. A held key that does not open the existing agent vault fails closed and leaves the server copy as it was.
6. **A space vault is a second key.** `kernel/identity/space-vault.js` draws a random 32-byte key per generation, seals it to each member and to a server key that stays in the space vault directory, and seals each item under HKDF of that key (item id and name in the AAD). Agents and Flows open items with the server wrap while no member is unlocked. Removing a member calls `rotateOnRemove`, which never throws, so removal still finishes. Rotation journals `copying` then `committing`. A crash before the generation pointer moves leaves the old generation readable; `resume()` discards the half-written next generation. A crash after the pointer moves drops the old generation. If rotation throws, the failure is written beside the space vault, retried automatically (`pumpRetries`, including the next time identity starts), and shown in Needs you through `vault.space.attention`.
7. **Lending is unchanged in shape.** `vault.space.use` and `externalMcp` (`vault_space_request`) put the value into the outbound request (Authorization bearer, or `{{secret}}` in a header or body that already names it) and return the response with the value replaced by `[redacted]`. The external caller gets that response and never the value. No member has to be online, because the server wrap opens the item.
8. **Ownership transfer is the existing kernel grant.** `spaces.owner.transfer` is the same registration as `spaces.members.transfer` and calls `grants.transferOwner`. The audit line is `owner.changed`. There is no second transfer implementation.
9. **An agent proposes. The person's tap applies.** Tools that change people, devices, ownership or vault access are `outward` and `ASK_FIRST`. A hosted key may name exactly the tools in the `gate` object of `core/modules/hosted-allow.json`. That file is the only declaration. `hostedKeyMay` reads it. Each of those tools is held for one tap. `identity.unlock` is not on it: unlocking is the person entering the master password. `vault.space.use` is not on it: it lends, and holding it would stop lending. `identity.lock` stays the person's own act.

## Consequences

- A stolen recovery key is a bearer for the device that holds the master record, and a founder code key on the chain. Say that on the one screen that shows it.
- After migration the server copy of the master key still opens the personal vault while nobody is unlocked, so lending does not wait.
- `devices.signin` does not open a network connection. Pairing remains the other workstream.
- The GitHub link is a login and a subject. There is no OAuth token in the master record.
- Secret-shaped fields (`password`, `passphrase`, `secret`, `secretKey`, `recovery`, `recoveryKey`) are removed before an approval card is built, stored or hashed. The person's own surface supplies the master password.

## Proof

`kernel/identity/master.test.js` pins the Argon2id vector, the recovery unwrap, and a migration that strips the plaintext key and leaves `vault/key`. `core/vault/master-root.test.js` shows the unlocked master key is the device key the vault adopts, a mismatched master key fails closed, and an item still opens with nobody unlocked. `kernel/identity/space-vault.test.js` crashes a rotation before and after commit, proves an external MCP `tools/call` of `vault_space_request` receives the HTTP result while the JSON result does not contain the secret, and shows a failed removal rotation stays flagged until the automatic retry finishes. `test/approval-secret.test.js` shows a password is absent from the card. `test/hosted-gate.test.js` shows the hosted gate is the declared allowlist.
