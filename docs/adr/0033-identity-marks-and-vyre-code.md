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

### 2a. Revision: wider outer margin, after a real decode finding (28 Sep)

`pwa`'s port (`deck/vyrecode/decode-core2.js`, work/pwa) found the first frozen geometry's outer
quiet margin too thin in practice: the code clipped at 120% scale and it limited how much room
perspective correction has to work with. The actual cause wasn't the ticks - it was the
**orientation marker** (section 2's disguised 3-dot cue), which reached further from centre than
any tick did (`r0 + 14 + 2*9 + its own radius` = `RING_R[1] + 37.1`, against the longest tick's
`RING_R[1] + 29 + a 2.25px round-cap` = `RING_R[1] + 31.25`) - the marker, not the payload marks,
was setting the real outer edge, and the first pass's margin arithmetic never accounted for it.

Fixed in `round5/vyrecode2.js` by pulling the rings in tight against the face and tightening the
marker's own footprint to match, rather than shrinking the face or enlarging the canvas:

- `RING_R = [FACE_R + 8, FACE_R + 8 + 34]` = `[188, 222]` (was `[210, 245]`) - the face-to-ring
  gap drops from 30 to 8, the ring gap itself goes from 35 to 34 (materially unchanged).
- `ticksSunburst` tick lengths: `6 + level*6` for level 0-3 = `6, 12, 18, 24` (was `8 + level*7`
  = `8, 15, 22, 29`).
- The marker's own offsets tighten from `r0 + 14 + k*9`, radius `2.5 + k*1.3` to `r0 + 8 + k*6`,
  radius `2 + k*1` (k = 0, 1, 2) - it no longer reaches past the ticks.

Result, computed directly (not eyeballed): outer quiet margin (canvas edge at radius 300 minus
the farthest of tick-reach 248.25 and marker-reach 246) is now **51.75 units, 8.6% of the 600
canvas** - inside the asked 8-10%. Ring-gap clearance (34 minus the longest tick's 26.25px
reach) is **7.75px**, comfortably positive and wider than before in relative terms even though
the raw gap number barely moved, because the ticks themselves got shorter.

**Frozen constants**, now sourced from `round5/geometry.js` (see 2b below), at a 600x600 canvas:
`FACE_D = 360` (`FACE_R = 180`), `RINGS = 2`, `PER_RING = 36`, `RING_R = [188, 222]`,
`ticksSunburst` tick lengths `6, 12, 18, 24`, marker offsets `r0 + 8 + k*6` with radius
`2 + k*1`.

**The invariant, restated correctly this time:** the outer edge is set by
`max(RING_R[1] + longest-tick-reach, RING_R[1] + marker-reach)`, not by the ticks alone - the
first pass's mistake. Any future change to `RING_R`, the tick-length formula, `LEVELS`, or the
marker's own offsets must recompute both reaches and keep the outer margin at 8-10% of the
canvas and the ring-gap clearance clearly positive (treat today's 7.75px as thin, not a target to
shrink further), not just check the ticks.

Because `pwa`'s decoder hardcoded a second copy of these numbers rather than importing
`vyrecode2.js` directly, the two files drifted out of sync exactly once, requiring a manual
message to `pwa` and `launch` with the new values instead of an automatic update. Consolidated
below (2b) rather than left as a standing risk.

### 2b. Consolidation: one shared constants module (28 Sep, same day)

Lead's call once the drift above actually happened once: stop passing the numbers by hand and
give the geometry its own file both sides import. `round5/geometry.js` is now the single source
of truth for every constant and reach formula this ADR names - `CENTER`, `FACE_D`/`FACE_R`,
`RINGS`, `PER_RING`, `ANGLE_STEP`, `LEVELS`, `RING_R`, the tick-length formula (`tickLength(level)`,
`TICK_STROKE_WIDTH`, `tickReach(level)`), and the marker's offset/radius formulas
(`markerOffset(k)`, `markerRadius(k)`, `markerReach()`). It also exports `outerReach()` and
`validateGeometry()`, which recomputes both the margin-percent and gap-clearance invariants from
section 2a and throws with a specific reason if either regresses - a change that breaks the
invariant now fails loudly at load time instead of shipping unnoticed. `vyrecode2.js` imports
from it and calls `validateGeometry()` at module load; verified live (not just read) - a
deliberately-broken threshold throws the expected message, a real render still produces the same
51.75px margin / 7.75px clearance as 2a.

`pwa` and `launch` should both vendor `geometry.js` itself (alongside the other vendored files:
`rs.js`, `payload.js`, `identity.js`, `vyrecode2.js`, `creature.js`) and import its constants and
`tickLength`/`markerOffset`/`markerRadius` functions, rather than hand-copying values into
`decode-core2.js` or a second render-side file. Any future geometry change then lands once, in
one file both sides pull from, and `validateGeometry()` catches a bad edit before it ships
instead of relying on a person to notice.

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
- `round5/geometry.js` is the shared constants module (2b); `pwa` and `launch` both vendor and
  import it rather than restating its values. Its `validateGeometry()` is the enforcement point
  for the margin/gap invariant from 2a - run it (or let module load do so) after any edit to the
  file.
