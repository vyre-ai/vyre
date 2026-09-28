---
title: "ADR 0042: The move engine"
summary: How a person moves from one machine to another (laptop to server, server to server), what stays live while it copies, how the vault crosses without ever touching disk unsealed or copying trust itself, and how the person confirms and later frees the source.
audience: builders
owner: federation
status: draft
---

# ADR 0042: The move engine

Status: draft, 28 Sep 2026 (revised after the reviewer's first pass) · Workstream: federation ·
Carries out ADR 0039 section 4 (docs/design/anywhere.md, not yet merged here) and the move
contract already sent to launch and tailnet (docs/work/federation.md, "Move engine: contract
only")

## Context

"Move to a server" (launch's Settings panel, already built against this contract) needs an engine
behind it: copy a person's four pieces - projects, memory, vault, sessions - from one machine to
another, without the source ever going dark mid-move, without a vault item ever sitting on disk
outside a seal, and without deleting anything until the person says so twice (once to confirm the
new home works, once to actually free the old one's space).

The team-lead's five constraints for this pass:

1. The source stays live during the whole copy - never taken offline, never read-only, nothing
   about it changes until the person confirms.
2. Vault items are re-encrypted end to end; never in plaintext on disk, on the source or the
   destination, at any point.
3. The plan carries real counts and sizes per piece before anything moves.
4. There is undo, and a confirm step that is separate from the copy finishing.
5. Freeing space on the old machine is the person's own, separately previewed action - never a
   side effect of confirming the move.

Plus a transport decision: **the relay introduces, Tailscale carries.** Two machines that have
never spoken need a way to find and trust each other first; once they have, the bytes go over the
tailnet directly, not through the relay's own websocket bridge (ADR 0026), which is a control-plane
path (pairing, small requests, presence), not built or sized for a whole vault and session history.

The reviewer's first pass on this note found three HIGHs the constraints above did not cover: who
the destination really is (not merely "a reachable tailnet node"), that the destination must
consent to receive, and that a vault carries secrets, never trust. This revision folds all three
in before any code is written.

## Decision

### 1. Four pieces, copied independently, confirmed together

Unchanged from the contract already sent out: `projects`, `memory`, `vault`, `sessions`. Each
copies and verifies on its own; nothing here waits on another piece to start, and a piece that
fails is retried on its own, not the whole move. The final flip (which piece "wins" as the
person's live machine) is a single gate all four must clear together - `stage: "ready"` is never
partial.

### 2. Who the destination is (reviewer's HIGH 1)

A move ships every secret the person has. "A reachable tailnet node" is not who: under the Wink
model a desktop is *tagged*, so `tailscale whois` gives back a tag, not the owner - a shared-tailnet
peer, a guest device, or someone else's box could all resolve to a live, reachable node without
being this person's own.

`move.plan { destination }` refuses anything the destination cannot be proven to be, checked
against a **pairing record of this owner**, not a whois lookup: the destination's pinned stable id
and its vyred's own static key, recorded when it was paired (tailnet's `onboard.join`/`relay.join`
flow, ADR 0026 - the move engine trusts that record, never re-derives identity from the network
itself). **Needs from tailnet:** which existing pairing table is the authoritative "this node is
one of the owner's own" record (`relay_devices`, `link_peers`, or a new one) - the move engine
reads it, never writes it, and never invents a second identity path the way federation's own
lib/caller.js note warns against elsewhere in this codebase.

Both sides authenticate each other before a byte moves: the destination checks the source's pinned
identity the same way, from its own copy of the same pairing record. A move is refused, not merely
declined, if either side cannot confirm the other from a pinned record rather than the network's
say-so.

### 3. The destination must consent to receive (reviewer's HIGH 2)

As drafted before this revision, anything that could reach the destination's move endpoint could
push data into it - planting memory, secrets or sessions with nothing on the receiving end ever
having agreed to accept them. Fixed: **the destination accepts a move only for a token minted on
itself, by a person present at it.**

- `move.receive.open { }` (HUMAN_ONLY, run **on the destination**): mints a one-time receive token,
  short-lived (minutes, not the plan's own longer window), shown as a code or QR the person carries
  to the source (the same shape a pairing code already takes, ADR 0026). Nothing is accepted before
  this has been minted.
- `move.start { planId, receiveToken }` (run **on the source**, HUMAN_ONLY): the token proves a
  person at the destination is expecting this specific source (bound to the source's own pinned
  identity from section 2, not just "some move"). The destination's endpoint verifies the token,
  the source's pinned identity, and the `moveId` together before accepting the first chunk of any
  piece; a token is consumed on first successful bind and cannot authorize a second, later attempt.
- Without a live receive token, the destination's move endpoint refuses every write outright, the
  same "not available" shape the rest of Vyre uses for a refusal that must not leak why.

### 4. What the vault piece actually carries (reviewer's HIGH 3)

Applying ADR 0040's rule here: **item secrets move; trust state never does.** A vault is not one
undifferentiated blob - splitting it wrong would either leave the person's passwords behind (data
loss) or silently duplicate device trust onto a machine that was never the one enrolled for it
(a real security hole, not a convenience). Three kinds, three different rules:

- **Item secrets** (passwords, API keys, notes - the things a person actually keeps in the vault
  for their own recall): move, re-encrypted end to end (section 5). These are the only rows that
  count toward the vault piece's bytes and counts in `move.plan`.
- **Trust state** (presence keys, the Capsule's own pin, sessions bound to a specific device,
  pairing and device records for relay/link): **never copied.** Each is made fresh on the
  destination, the same way it was made the first time (a new presence enrollment, a new Capsule
  pairing, a device re-pairing itself to the new home). `move.plan` reports these separately from
  the vault's byte count, as a plain list of what will need setting up again, not folded into "N
  items moved."
- **Grants** (which agent or project may reach which vault item): shown to the person **on the
  destination** for re-approval, one at a time or in a batch they can see, never inherited
  silently. A grant that existed on the source is a fact about the source's own vault; the
  destination's vault starts with none until the person says otherwise.

`move.status`'s vault entry therefore carries three numbers, not one: `moved` (item secrets),
`remade` (trust-state pieces the person will redo, named), `pending_grants` (waiting for
re-approval on the destination).

### 5. Transport: introduce once over the relay, carry every byte over Tailscale

- **Introduction.** If the destination cannot be proven to be the owner's own node (section 2),
  `move.plan` refuses with `not_reachable` and points at tailnet's own join flow: the relay's QR
  pairing and Noise handshake establish who the destination is and put it on the same tailnet. The
  move engine does not reimplement pairing, trust, or Noise - that is tailnet's and relay's
  contract, not this one's.
- **A fresh handshake for the move itself (reviewer's MEDIUM).** The introduction that first paired
  the two nodes may be weeks old. Every per-item session key (section 6) comes from a handshake
  run fresh at `move.start` time, between the two pinned static keys from section 2 - never the
  original introduction's own key, however it was derived, reused stale.
- **Carrying.** The actual copy is a direct, tailnet-only connection between the two vyreds, the
  same trust model `core/link/transport.js` already gives the Mac-to-box pairing (peer looked up
  by `tailscale whois` before a byte is sent, then checked against the pinned pairing record from
  section 2, not trusted from whois alone - the Wink tagging problem again). That file is scoped
  to exactly one pairing shape (a Mac client, a box server) today; this needs the same guarantee
  between any two Vyre nodes, source-initiated. **Needs from tailnet:** a `move`-flavoured open (or
  a generalised `transport.open` that takes either side's role) before `move.start` can build on
  it. Flagged, not assumed.
- **Never over the relay's bridge.** The relay stays what it has always been: introduction,
  presence, small control messages. A move that has not yet joined the tailnet does not fall back
  to relaying its bytes through it; it waits, and says why (`not_reachable`).
- **Implementation note, not yet resolved:** on a Mac running vyre-core (ADR 0040 phase 2), the
  vault is exported by core, not vyred. The move engine's vault piece will need to call into
  whichever process actually holds the vault on that machine, not assume vyred always does; flagged
  here so the build doesn't wire the vault piece straight into vyred on every platform by default.

### 6. Vault item secrets: re-encrypted end to end, never unsealed on disk

Mirrors what `core/vault/backup.js` already does for a manual export/restore (see its own header:
"restoring re-seals every item under the master key of the vault it lands in, through the same
`put()` every other item goes through"), minus the passphrase step, which is for a cold file a
person carries by hand, not a live device that just joined the tailnet:

- On the source, one item secret at a time: read and decrypt it (as any use of the vault already
  does), encrypt it under the fresh, move-specific session key (section 5), send it, and discard
  the decrypted bytes from memory immediately after.
- On the destination: decrypt from the session key, then re-seal at once under the destination's
  own master key through its own `put()` - the same call path every other item takes getting into
  a vault. The item is in the clear only in a variable between those two decrypt/encrypt steps, on
  each side, never written to a temp file, never logged.
- Trust state (section 4) never reaches this path at all: it is not read from the source's vault
  for a move in the first place.
- An item secret that already lives at the destination (say, a re-run after a partial failure) is
  compared by its own integrity check, not re-sent if unchanged - `move.status`'s resumability
  (below) applies to the vault piece the same as any other.

### 7. The tools

`move.plan { destination }` (HUMAN_ONLY): a dry run against a destination proven to be the owner's
own (section 2). Counts and bytes per piece (projects, memory, vault's item secrets only, sessions),
the vault's separate `remade`/`pending_grants` lists (section 4), and a `planId` - a hash of the
four pieces' current state, so a stale plan can never be started against (constraint 3). No write,
nothing moved, nothing on the source touched.

`move.receive.open { }` (HUMAN_ONLY, on the destination): mints the one-time receive token, section
3. Nothing else in this ADR accepts a write without one.

`move.start { planId, receiveToken }` (HUMAN_ONLY, on the source): begins copying to the
destination over the tailnet connection from section 5, piece by piece, source untouched and fully
itself for the whole run (constraint 1). Returns a `moveId`. Refuses a stale `planId` (the source
changed since the plan), a missing or already-used `receiveToken`, or a destination that fails the
mutual pinned-identity check, rather than starting against a wrong count or an unconsenting machine.

`move.status { moveId }` (owner-only, reviewer's LOW): `{ stage:
"copying"|"verifying"|"ready"|"confirmed"|"failed", pieces: { projects: { bytes, of, done, error },
memory: {...}, vault: { moved, of, done, error, remade: [...], pending_grants: [...] },
sessions: {...} } }`. Resumable: a status check after a restart of either machine picks up where
copying left off, never re-starts a finished piece (or an item secret already verified present).

`move.confirm { moveId }` (HUMAN_ONLY): the person's go-ahead once `stage: "ready"` - every piece
copied, and the destination has verified its own checksums, item secrets included. Marks the move
confirmed and emits `move.confirmed { moveId }`; anywhere's `onboard.machine` is what actually
flips `config.machine` on the source (this engine only reports the fact, never calls it directly -
that boundary belongs to anywhere, per the contract already agreed). This step never deletes
anything on the source (constraints 4 and 5): the source is still fully itself, just no longer the
one `config.machine` points a fresh session at.

`move.cancel { moveId }` (PERSON_ONLY, instant): stops an in-flight or ready-but-unconfirmed move.
The source was never touched, so this is cleanup of the partial destination copy only.

`move.free { moveId }` (HUMAN_ONLY, only after `stage: "confirmed"`): constraint 5's own action,
entirely separate from `move.confirm`. `move.free.preview { moveId }` first (bytes reclaimed per
piece, same shape as the plan); `move.free` itself re-checks the destination live (reviewer's LOW:
refuses unless the destination has checked back recently and its checksums still hold, not merely
what they were at confirm time) before it deletes the source's own copy of the four pieces - a
second, distinct gate from the confirm above, on purpose (a person who confirmed a move because the
new machine looked fine, then found a gap a day later, must still have the old one).

### 8. Events

`move.progress { moveId, piece, bytes, of }` (throttled, not per chunk), `move.piece.done
{ moveId, piece }`, `move.failed { moveId, piece, error }` (retried by a fresh `move.start`
against the same `planId`, not a special recovery path), `move.confirmed { moveId }`,
`move.freed { moveId }`.

### 9. Checksums, not trust

Every piece's checksum is verified on the destination before `stage` reaches `"ready"`; vault item
secrets are verified by re-sealing successfully and reading them back once, not merely by the
bytes arriving. A piece whose checksum fails is retried, never surfaced to the person as "ready"
with a silent mismatch. `move.free` repeats this check live (section 7) rather than trusting the
plan-time result.

## Open question, sent to anywhere

Whether vault and sessions need to move atomically together (a session mid-thread holding a
vault-derived credential) or each piece can lag independently as above - the four-piece split
otherwise fits the engine's real constraints (each piece copies and verifies on its own, no
cross-piece ordering needed except the final confirm gate, and now the free gate after it).

## Needs from others

- tailnet: which pairing table is the authoritative "this node is the owner's own" record (section
  2), and the generalised, source-initiated transport open (section 5) -
  `core/link/transport.js` today is scoped to the Mac-to-box pairing shape only.
- anywhere: confirms `onboard.machine` is the only thing that flips `config.machine`, listening for
  `move.confirmed` (already the agreed boundary, restated here since this is the first ADR to spell
  out the free step too).
- relay/tailnet: confirms `move.plan`'s `not_reachable` refusal is the right seam for "not joined
  yet, or not provably the owner's own", rather than this engine growing its own identity path.
- vyre-core (ADR 0040 phase 2): whoever owns the Mac's core process, for the vault export call the
  move engine's vault piece will need to make there instead of assuming vyred holds the vault.

## Consequences

A move never has a moment where a vault item secret sits decrypted anywhere but a live process's
memory, on either side, and it never copies the trust that made the source's vault trustworthy in
the first place - that trust is remade fresh on the destination, with the person's own eyes on
every grant. A destination never receives anything it did not, itself, ask for. A person can walk
away mid-copy, come back, and either resume or cancel with the source exactly as it was. Freeing
the old machine's disk is never bundled into the same decision as trusting the new one, and it is
checked live, not assumed, before it happens.
