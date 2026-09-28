---
title: "ADR 0033: Identity marks: four families, and the Vyre code"
summary: Vyre has four visual identity families with distinct silhouettes (person circle, assistant creature, agent blob, teammate tile), none resembling any AI brand's own mark. The person's circle carries a second, scannable form (the Vyre code) that encodes a one-time pairing ticket, read only by phone.vyre.run's own decoder - not a standard QR, and no normal-camera fallback.
audience: builders, agents
owner: app-design
status: draft
---

# ADR 0033: Identity marks: four families, and the Vyre code

## Context

avatar.md already drew one line: agents and teammates get tiles, only the person gets a circle,
no photos, no colour per agent or person. Five rounds of generated-avatar work (round 1 through
round 5, `docs/work/app-design.md`) grew that into four families with distinct silhouettes, and
the user asked for a scannable form of the person's own mark to pair a phone: not a standard QR
(any camera reads a QR; this should be ours, read only by phone.vyre.run's own decoder, with no
normal-camera fallback path), seeded from a stable public identity such as a public-key
fingerprint, never a secret.

Round 5 built and proved the encoding (`rs.js`, `payload.js`, `decode-core.js`, `harness.js`):
144 bits (a 64-bit id + CRC-8, Reed-Solomon-protected) laid out as marks around the face, 14/17
real degradation scenarios decoding correctly in headless Chrome (blur, rotation, scale, noise;
the 3 misses are all camera-tilt/perspective, a known next step, not a design gap). The first
render pass looked wrong to the user ("eww": stark rings, a face rendered at a third size from a
stripped-viewBox bug); the beauty pass fixed both and is what this ADR specs.

## Decision

### 1. Four identity families, one silhouette rule

Every mark in Vyre is one of exactly four families, each with a shape no other family uses, so
identity reads before any content (name, colour, initial) loads:

| Family | Shape | Content | Source |
|---|---|---|---|
| Person (you) | True circle | Warm two-tone gradient, a calm face (no hair, no accessory) | `round4/identity.js` `userAvatar` |
| Assistant | Companion creature | A plump rounded body, glow halo, ears, curled tail, a sparkle-eyed face | `round5/creature.js` `creature` |
| Agent | Organic blob | A spikier, more angular wobble; a plain dot-eyed face | `round3b` generator |
| Teammate | Rounded-square tile | Initial or a rolled character (hair/headwear/glasses/role prop), radius size/4 | `round3b` generator, `docs/design/system/components/avatar.md` |

The assistant is deliberately its own species, not a fifth agent and not a smaller person: round 4
first gave it a squircle with an abstract mark (`assistantAvatar`), but the user's later direction
was a creature, so `creature.js` is the shipped assistant family and the squircle direction is
superseded (kept in identity.js for its palette/contrast fix, not for its shape). An agent blob
and the assistant creature must never be recolourable into each other by seed alone: they draw
from separate palettes (agents' existing set vs. `creature.js`'s `PASTELS`) specifically so a
colour coincidence never reads as "an agent in a different pose."

**No mark in any family may resemble a major AI brand's own mark** (avatar.md's existing rule,
restated here because it now covers four families instead of one): Gemini's four-point sparkle,
Claude's starburst, OpenAI's knot, Copilot's shape, Perplexity's compass-like glyph. This is a
design review step on every round, not a licence check, and it caught a real hit once already
(the first assistant-mark direction read as Gemini's sparkle, original artwork or not).

### 2. The Vyre code: a live, scannable form of the person's circle

The person's everyday circle (24-40px, avatar.md's existing sizes) is unchanged. At full size
(pairing, a "show my code" screen) it grows a ring of marks around the same face and palette,
the **Vyre code**:

- **Geometry.** Face fills 60% of the diameter (`FACE_D = 0.6 * size`) - large enough that the
  identity still reads as "a person," not "a barcode." Two rings of marks sit just outside the
  face (not four; round 5's first pass used 4 rings of 1-bit marks and read as a stark technical
  ring the user disliked). Each ring holds 36 marks at 10-degree spacing, 72 marks total, each
  mark carrying 2 bits (4 discrete sizes/lengths, not just on/off) = 144 bits, the same payload
  as the first pass at half the visual density.
- **Palette.** Never flat black/white. The ground is the theme's own neutral (`#0E0D0C` dark /
  `#F4F1EA` paper) with a soft wash of the face's own gradient warm stop mixed in at 92% neutral
  (a first attempt at 86% hue read as a flat saturated block - the "eww" - fixed by pushing it
  back to a whisper). Marks come in two shades of that same stop: a muted tint for level 0-1, the
  deep stop for level 2-3. The result is "the avatar's own palette," never a separate ring colour
  bolted on.
- **Orientation marker.** Three dots ascending in size at 12 o'clock, in the same visual language
  as the marks (not a separate glyph) - a human "this is the top" cue only. It is never
  load-bearing for decode; the rotation+scale search in `decode-core.js` and Reed-Solomon
  validation do the real work, so a torn or occluded marker does not fail the scan.
- **Three visual directions, one geometry**, so picking a direction never touches the decode
  path: `dotsPalette` (size = 2-bit value), `dashesRounded` (pill length, the Spotify-code look),
  `ticksSunburst` (thin radial tick, length = 2-bit value - the direction flagged most promising).
  All three share the exact same mark positions and bit-per-mark convention.
- **The assistant gets the same ring technique** via `renderCode2`'s `faceSvg` override -
  `creature.js`'s creature drawn at the centre instead of the person's face, same palette
  derivation, same ring geometry - "same hand," never a separately invented ring for the second
  family that needs one.

**Frozen constants** (`round5/vyrecode2.js`, at a 600x600 canvas; `pwa` has ported these as
fixed values into `deck/vyrecode/decode-core2.js`, not by importing the source, so a change here
does not propagate automatically - see the note below): `FACE_D = 360` (`FACE_R = 180`),
`RINGS = 2`, `PER_RING = 36`, `RING_R = [FACE_R+30, FACE_R+65]` = `[210, 245]`, `ticksSunburst`
tick lengths `8 + level*7` for `level` 0-3 = `8, 15, 22, 29`.

**A tight invariant, load-bearing for decode, not just visual:** the two rings sit only 35px
apart (`RING_R[1] - RING_R[0]`), and a ring-0 tick draws outward from its base, so the longest
mark (29px) reaches to `210 + 29 = 239` - only 6px short of ring 1's own base at 245. Any future
change to `RING_R`'s gap, the tick-length formula, or `LEVELS` must keep the longest ring-0 mark
clear of ring 1's base with margin, or ring-0 and ring-1 marks become visually and
sample-wise ambiguous at the decoder. Treat 6px as the current, already-thin margin, not a target
to shrink further.

Because `pwa`'s decoder hardcodes a second copy of these numbers rather than importing
`vyrecode2.js` directly, the two files can silently drift if either changes alone. Whoever next
touches either file should either keep both in lockstep by hand (cross-check before merging, as
`pwa` flagged) or - the safer fix - have the decoder import the constants from a single vendored
copy of `vyrecode2.js` instead of restating them.

### 3. What the code carries, and what it doesn't

The Vyre code's payload is a public identifier plus, for pairing, a one-time ticket: 64 bits of
ticket plus a CRC, Reed-Solomon-protected the same way. Scanning it reveals only what the
person's own profile already shows; it grants nothing by itself. `phone.vyre.run`'s scanner
reads the ring and completes pairing only alongside the device-side proof (Touch ID or presence)
that ADR 0032 already requires for a person-level action - the code identifies the ticket, it
does not authorize by itself.

There is no plain-QR fallback and no normal-camera support (user decision, 2026-09-28): the Vyre
code is our ring only, read exclusively by phone.vyre.run's own decoder. A plain QR encoding the
same payload was considered - as the fallback path for a generic camera that isn't running Vyre's
decoder - and turned down: it would let any camera read the payload, which is exactly what the
ring exists to avoid, and it would mean shipping and maintaining two decode paths for one
identifier. If a non-Vyre entry point to pairing is ever needed, it should be a separate,
explicitly weaker mechanism (e.g. a typed code), not a QR twin of this ring.

### 4. Known gap, scoped

3 of 17 real degradation scenarios fail decode, and all 3 are camera-tilt (perspective): the
current search models rotation and uniform scale only, which is an affine model, and a true
tilt is a homography that distorts the two ring radii unevenly across the frame. Fixing this
needs 3-4 detected reference points (the marker, the rim) and a solved homography, not another
search parameter - the next real step for whoever wires this into `pwa`'s decoder, not a blocker
on shipping the visual spec.

## Consequences

- `avatar.md` gains the four-family table and the Vyre code section below; `pwa` ports
  `decode-core.js` and `rs.js` as-is (original code, a public algorithm, no licence question);
  `launch` renders `vyrecode2.js`'s output on the Deck's pairing screen.
- A bug fixed at the source as part of this round, worth a line here since it would otherwise
  recur: `renderCode2` stripped a face SVG's outer `<svg>` tag to inline its content, which also
  throws away the browser's automatic viewBox-to-size scaling - the face rendered at its native
  120 units inside a 360-unit slot (a third size) until the wrapper read the face's own viewBox
  and scaled explicitly. Fixed generically (reads whatever viewBox the face source declares),
  not pinned to today's 120.
