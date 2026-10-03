---
title: "ADR 0051: The identity chain"
summary: A person or a space is a permanent id plus a signed, chained list of who can speak for it. The name directory holds only public keys, verifies every change against the previous list, and cannot forge an entry.
audience: builders
owner: windows
status: draft
---

# ADR 0051: The identity chain

Status: draft, 3 Oct 2026 · Workstream: windows · Implements team/0.3/DESIGN-wink.md section 2.

## Context

Until now a Vyre name pointed at one key, and a lost key meant a 72 hour wait and a recovery code. The Wink design makes the identity itself the
thing that lasts, and the keys that speak for it replaceable.

## Decision

An identity is a permanent id (`per_` or `spc_` plus 26 base32 characters of the hash of its genesis op) and a chain of signed ops over a list of
entries. `names/worker/chain.js` is the one implementation, WebCrypto only, run by the directory Worker, the Node client and any browser.

- **Entries (a person):** `device` keys, one `code` key (the recovery code and an optional PIN stretched with scrypt into an Ed25519 key, so only the
  public half is on the list) and optional `contact` keys (a recovery contact holds the private half and signs only a recovery).
- **Entries (a space):** `owner`, each a person identity, acting through one of that person's devices, checked against that person's own chain as it
  stood at the op's time.
- **Ops:** `genesis`, `add`, `remove`, `replace-code`, `recover` (two contacts approve a new device). Every op names the previous op's hash, so the list
  is a chain, and is signed by an entry already on the list.
- **Newcomer rule:** an entry added under 24 hours ago works at once but cannot remove older entries, touch the code or contacts, or (for a space)
  change owners. An older device removes it in one op. The first device and the code made with it are founders and never count as newcomers.
- **Time:** an op's own time may not run backwards along the chain nor ahead of the verifier's clock by more than five minutes.

The directory (`names/worker/ids.js`) stores the chain, an opaque sealed record (sealed under a key derived from the name) and own-domain aliases. It
has no list or search route. Every write carries its own proof, so no request signature is needed and a relay cannot forge a change. It verifies each
appended op against the stored list. A client keeps the head it last verified (`pinOf`) and `checkAnswer` refuses an answer that is shorter than the
pin (stale) or has a different op at the pinned place (fork), so an operator cannot rewind or rewrite a list unnoticed. Anyone can run their own
directory; the client takes the base address.

## Consequences

- No wait and no takeover: recovery is a chain op, and the newcomer rule stops a thief with the code from removing anyone for a day. The honest limit
  stays: whoever holds the code and the PIN can read until an older entry removes them.
- Devices are never members of a space. Access flows through the person's identity, which a space's membership names by id.
- The space's own chain id is its permanent identity; the module's internal `spaceId` (the home, key and unit files) is kept beside it in the record.
- Invites go to an identity (`to`), and a join is checked against the directory's current list for the person's name, so a removed device cannot join.
- The directory is called by name only. Looking up an owner of a space uses the name carried on that owner's entry.
