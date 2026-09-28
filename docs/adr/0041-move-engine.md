---
title: "ADR 0041: The move engine"
summary: How a person moves from one machine to another (laptop to server, server to server), what stays live while it copies, how the vault crosses without ever touching disk unsealed, and how the person confirms and later frees the source.
audience: builders
owner: federation
status: draft
---

# ADR 0041: The move engine

Status: draft, 28 Sep 2026 · Workstream: federation · Carries out ADR 0039 section 4
(docs/design/anywhere.md, not yet merged here) and the move contract already sent to launch and
tailnet (docs/work/federation.md, "Move engine: contract only")

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

## Decision

### 1. Four pieces, copied independently, confirmed together

Unchanged from the contract already sent out: `projects`, `memory`, `vault`, `sessions`. Each
copies and verifies on its own; nothing here waits on another piece to start, and a piece that
fails is retried on its own, not the whole move. The final flip (which piece "wins" as the
person's live machine) is a single gate all four must clear together - `stage: "ready"` is never
partial.

### 2. Transport: introduce once over the relay, carry every byte over Tailscale

- **Introduction.** If the destination is not already a paired, tailnet-reachable node, `move.plan`
  refuses with `not_reachable` and points at tailnet's own join flow (`onboard.join`/`relay.join`,
  ADR 0026): the relay's QR pairing and Noise handshake establish who the destination is and put
  it on the same tailnet. The move engine does not reimplement pairing, trust, or Noise - that is
  tailnet's and relay's contract, not this one's. Once joined, the destination has a real tailnet
  address, and every request in this ADR happens on it.
- **Carrying.** The actual copy is a direct, tailnet-only connection between the two vyreds, the
  same trust model `core/link/transport.js` already gives the Mac-to-box pairing (peer looked up
  by `tailscale whois` before a byte is sent, pinned to the node that was joined, never guessable
  from DNS). That file is scoped to exactly one pairing shape (a Mac client, a box server) today;
  this needs the same guarantee between any two Vyre nodes, source-initiated. **Needs from
  tailnet:** a `move`-flavoured open (or a generalised `transport.open` that takes either side's
  role) before `move.start` can build on it. Flagged, not assumed.
- **Never over the relay's bridge.** The relay stays what it has always been: introduction,
  presence, small control messages. A move that has not yet joined the tailnet does not fall back
  to relaying its bytes through it; it waits, and says why (`not_reachable`).

### 3. Vault: re-encrypted end to end, never unsealed on disk

Mirrors what `core/vault/backup.js` already does for a manual export/restore (see its own header:
"restoring re-seals every item under the master key of the vault it lands in, through the same
`put()` every other item goes through"), minus the passphrase step, which is for a cold file a
person carries by hand, not a live device that just joined the tailnet:

- On the source, one item at a time: read and decrypt it (as any use of the vault already does),
  encrypt it under the transport's own session key (the Noise-derived key from the introduction
  step, forward-secret, torn down when the move ends), send it, and discard the decrypted bytes
  from memory immediately after.
- On the destination: decrypt from the session key, then re-seal at once under the destination's
  own master key through its own `put()` - the same call path every other item takes getting into
  a vault. The item is in the clear only in a variable between those two decrypt/encrypt steps, on
  each side, never written to a temp file, never logged.
- A vault item that already lives at the destination (say, a re-run after a partial failure) is
  compared by its own integrity check, not re-sent if unchanged - `move.status`'s resumability
  (below) applies to vault the same as any other piece.

### 4. The tools

`move.plan { destination }` (HUMAN_ONLY): a dry run against a reachable destination (joined via
tailnet's own flow, see 2 above). Counts and bytes per piece (projects, memory, vault, sessions),
and a `planId` - a hash of the four pieces' current state, so a stale plan can never be started
against (constraint 3). No write, nothing moved, nothing on the source touched.

`move.start { planId }` (HUMAN_ONLY): begins copying to the destination over the tailnet
connection from 2, piece by piece, source untouched and fully itself for the whole run
(constraint 1). Returns a `moveId`. Refuses a stale `planId` (the source changed since the plan)
rather than starting against a wrong count.

`move.status { moveId }`: `{ stage: "copying"|"verifying"|"ready"|"confirmed"|"failed",
pieces: { projects: { bytes, of, done, error }, memory: {...}, vault: {...}, sessions: {...} } }`.
Resumable: a status check after a restart of either machine picks up where copying left off,
never re-starts a finished piece (or a vault item already verified present, per 3).

`move.confirm { moveId }` (HUMAN_ONLY): the person's go-ahead once `stage: "ready"` - every piece
copied, and the destination has verified its own checksums, vault items included. Marks the move
confirmed and emits `move.confirmed { moveId }`; anywhere's `onboard.machine` is what actually
flips `config.machine` on the source (this engine only reports the fact, never calls it directly -
that boundary belongs to anywhere, per the contract already agreed). This step never deletes
anything on the source (constraint 4 and 5): the source is still fully itself, just no longer the
one `config.machine` points a fresh session at.

`move.cancel { moveId }` (PERSON_ONLY, instant): stops an in-flight or ready-but-unconfirmed move.
The source was never touched, so this is cleanup of the partial destination copy only.

`move.free { moveId }` (HUMAN_ONLY, only after `stage: "confirmed"`): constraint 5's own action,
entirely separate from `move.confirm`. `move.free.preview { moveId }` first (bytes reclaimed per
piece, same shape as the plan); `move.free` itself deletes the source's own copy of the four
pieces only after that preview has been shown and the person says so again - a second, distinct
gate from the confirm above, on purpose (a person who confirmed a move because the new machine
looked fine, then found a gap a day later, must still have the old one).

### 5. Events

`move.progress { moveId, piece, bytes, of }` (throttled, not per chunk), `move.piece.done
{ moveId, piece }`, `move.failed { moveId, piece, error }` (retried by a fresh `move.start`
against the same `planId`, not a special recovery path), `move.confirmed { moveId }`,
`move.freed { moveId }`.

### 6. Checksums, not trust

Every piece's checksum is verified on the destination before `stage` reaches `"ready"`; vault
items are verified by re-sealing successfully and reading them back once, not merely by the bytes
arriving. A piece whose checksum fails is retried, never surfaced to the person as "ready" with a
silent mismatch.

## Open question, sent to anywhere

Whether vault and sessions need to move atomically together (a session mid-thread holding a
vault-derived credential) or each piece can lag independently as above - the four-piece split
otherwise fits the engine's real constraints (each piece copies and verifies on its own, no
cross-piece ordering needed except the final confirm gate, and now the free gate after it).

## Needs from others

- tailnet: the generalised, source-initiated transport open (section 2) - `core/link/transport.js`
  today is scoped to the Mac-to-box pairing shape only.
- anywhere: confirms `onboard.machine` is the only thing that flips `config.machine`, listening for
  `move.confirmed` (already the agreed boundary, restated here since this is the first ADR to spell
  out the free step too).
- relay/tailnet: confirms `move.plan`'s `not_reachable` refusal is the right seam for "not joined
  yet" - pointing the person at the existing join flow rather than this engine growing its own.

## Consequences

A move never has a moment where the vault sits decrypted anywhere but a live process's memory, on
either side. A person can walk away mid-copy, come back, and either resume or cancel with the
source exactly as it was. Freeing the old machine's disk is never bundled into the same decision
as trusting the new one.
