---
title: "ADR 0043: Identity marks: four families, and the Vyre code"
summary: Vyre has four visual identity families with distinct silhouettes (person circle, assistant creature, agent blob, teammate tile), none resembling any AI brand's own mark. The person's circle carries a second, scannable form (the Vyre code) that encodes a one-time pairing ticket, read only by phone.vyre.run's own decoder - not a standard QR, and no normal-camera fallback.
audience: builders, agents
owner: app-design
status: draft
---

# ADR 0043: Identity marks: four families, and the Vyre code

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

### 2c. Paper-theme mark contrast (28 Sep, same day)

`pwa` reran their decode harness against the *real* renderer and palette (not their earlier
flat-color test fixture) after 2a/2b landed: pass rate dropped to 8/17 from an earlier 11/17,
with blur and scale-80 newly failing. Measured why rather than guessing, computing real WCAG
contrast ratios (mark/markDeep vs. the ring's own tint background) across all 4
`USER_GRADIENTS` options: dark theme was never the problem (8.5-12.3:1, light-on-near-black,
plenty of headroom). Paper theme was - the old formula gave `mark` (levels 0-1) only 2.96-4.44:1
and `markDeep` (levels 2-3) a genuinely weak **1.59-2.57:1**, because `markDeep` used the raw
gradient "deep" stop with no ink mixed in at all, unlike every other colour in the palette.
Compounding it: level 0's tick additionally rendered at 0.55 opacity with no decode-headroom
reasoning behind that number - the lowest-value mark was faint twice over.

Fixed in `paletteFor` (`round5/vyrecode2.js`): paper's `mark` mix deepened from a 0.3 to a 0.5
ink-mix, `markDeep` from an implicit 0 to a 0.65 ink-mix (still the gradient's own hue, just
enough `#141311` mixed in to hold contrast, not a flat black substitute - the same technique the
beauty pass already used elsewhere, applied with enough weight this time). Level 0's opacity
raised 0.55 -> 0.85. Result, computed the same way: worst case across all 4 options is now
**4.86:1 for mark, 7.35:1 for markDeep** - roughly double the prior floor. Dark theme and the
ring geometry (2a/2b) are unchanged; verified by re-running `validateGeometry()` and rendering
both themes after the edit.

Not verified here: whether 8/17 actually recovers with this fix, or by how much - that requires
`pwa`'s real decode harness, not arithmetic. If a gap remains after this, the next lever is
`pwa`'s own suggestion of a contrast-adaptive threshold in `decode-core2.js`, as a second layer
on top of (not instead of) fixing the source colours.

`pwa` and `launch` should both vendor `geometry.js` itself (alongside the other vendored files:
`rs.js`, `payload.js`, `identity.js`, `vyrecode2.js`, `creature.js`) and import its constants and
`tickLength`/`markerOffset`/`markerRadius` functions, rather than hand-copying values into
`decode-core2.js` or a second render-side file. Any future geometry change then lands once, in
one file both sides pull from, and `validateGeometry()` catches a bad edit before it ships
instead of relying on a person to notice.

### 2d. Avatar option: default from identity, optional pick (28 Sep, lead's ruling)

pwa's phone pairing screen needed to render "the same avatar" as the person's, and had no real
source for which avatar option to use - their stopgap (`sha256(box key)[0] % 4`) hashed the
wrong identity (a device/box key, not the person's own). Ruling: the **default avatar option is
derived deterministically from the identity's own 8-byte public fingerprint** - the same
fingerprint `payload.js`'s `fingerprint8` produces and the Vyre code itself encodes, never a
secret - so every person and every assistant gets a unique, stable avatar with zero setup ("unique
by design"). A **stored pick is optional, overrides the default, and only the person themself can
set their own** (never anyone else's, never derived from a device).

Implemented as `defaultAvatarOption(fingerprint8Bytes, optionCount)` in `round4/identity.js`:
`fingerprint[0] % optionCount`. Any single byte of a SHA-256 digest is uniformly distributed, so
byte 0 is as good as any other - picked for simplicity, not significance. Same function serves
both families: the person's own fingerprint for their avatar, the assistant's own separate
fingerprint for its creature (never the person's - `creature.js` already required this
separation for its palette; the option now follows the same rule). Verified live: a real
fingerprint through `payload.js`'s `fingerprint8` produces a deterministic option index and
renders through `userAvatar` without error.

Division of labour: `tailnet` puts the identity fingerprint in the verified ticket record now
(it's already carrying the public id for pairing); the stored-pick override is a real field
(`onboard.person.avatarOption` or equivalent) that `anywhere` (core/onboard) builds later - not
needed for 0.1.1, since every surface can compute the default from the fingerprint alone until
then. `avatar.md`'s Gaps names this explicitly so it isn't lost.

### 2e. Blur is the real signal, not (only) contrast (28 Sep, `pwa`'s per-mark diagnostic)

`pwa` sent raw per-mark error counts (of 72 marks) for the 8/17 run, at each scenario's own true
rotation/scale, real renderer, dark theme, `userOption 1`: pristine 3 errors (fine), rotate
15/37/90/181deg 5-6 errors each (fine - rotation doesn't touch contrast or size), noise light/
heavy 3 errors each (fine), scale 120% 1 error (fine) - but **blur 2px 18 errors, blur 4px 38,
blur 6px 56** (all fail, even light blur already 4-6x over the ~4-16 error budget RS can correct),
and **scale 80% 12 errors** (borderline/fails).

The pattern - blur catastrophic even at 2px, rotation/noise easily tolerable, scale-down also
hurting - points at absolute mark SIZE surviving a fixed-radius blur kernel, not primarily colour
contrast, though `pwa` initially read it as a contrast question (their real palette scored 8/17
against an 11/17 flat-colour test fixture). Checked the maths before assuming either explanation:
dark theme's WCAG contrast is already 11.74-12.31:1 (mark and markDeep both far exceed any
practical threshold) - raising it further was unlikely to be the real lever for this specific
case. What *did* change between round 5's original prototype (which passed all three blur levels
clean, per `NOTES.md`) and this beauty pass: 2a's margin fix shrank the tick lengths from
`8-29px` to `6-24px` to buy back outer margin. A short, thin stroke loses proportionally more of
its signal to a fixed-pixel blur kernel than a wider one does, independent of hue - the
mechanism `pwa`'s own "scale-80 also degrades" observation is consistent with (smaller absolute
marks either way).

Tried the geometry-only lever first, not the palette: widened `TICK_STROKE_WIDTH` 4.5 -> 6
(`round5/geometry.js`, matching `dashesRounded`'s own width) rather than lengths (which would eat
back into 2a's margin) or colour (which the mechanism above doesn't clearly implicate for dark,
and which the lead asked `pwa` not to touch directly). Re-verified the margin/gap invariant still
holds at the new width: margin 51 units (8.5% of canvas, still inside 8-10%), gap clearance 7
(was 7.75, still comfortably positive). **Not verified against `pwa`'s real harness** - this is a
hypothesis-driven change for them to test, not a claimed fix; if it doesn't move the blur numbers,
palette contrast (or accepting blur tolerance as a scoped gap, the way perspective already is)
is the next thing to try, not a mark-length increase that would reopen the margin problem 2a
fixed.

**Confirmed: the hypothesis was right, once a decoder-side bug it exposed was also fixed.**
`pwa`'s first rerun against the wider stroke was 0/17 - even pristine broke. Cause: a round
line-cap always overshoots a tick's nominal length by its own cap radius, and widening the stroke
grew that overshoot from 2.25px to 3px, which against `LEVELS`' tight 6px level spacing (6, 12,
18, 24) was enough to flip several marks a level high with zero degradation applied - a
decode-side reading of raw pixel length that never subtracted the cap radius before quantizing to
a level, not a rendering bug (the renderer draws exactly what the geometry says; `TICK_CAP_RADIUS`
was already exported from `geometry.js` for exactly this purpose, just not consumed on the decode
side yet). `pwa` fixed it in `decode-core2.js` (subtract `TICK_CAP_RADIUS` from the raw measured
length before quantizing). Result: **14/17**, matching round 5's original synthetic-fixture
ceiling almost exactly, now on the real palette and geometry. The remaining 3 failures are all
perspective (15deg, 30deg, the worst-case combo) - the same scoped, known limitation from round
5's first pass (see `NOTES.md`), not a new one. Reaching the stated 15/17 target needs the
homography correction already named as the next real step there, not further palette or geometry
tuning on this side.

### 2f. The identity seed, defined (28 Sep, lead's ruling, docs only)

2a-2e assumed an 8-byte fingerprint existed without specifying where it comes from; this defines
it, as the product input to `payload.js`'s `fingerprint8(publicSeed)`:

- **Person:** `sha256("vyre:person:v1:" + hex(owner.id))[0:8]`
- **Assistant:** `sha256("vyre:assistant:v1:" + hex(owner.id))[0:8]` - same `owner.id`, a
  different prefix, so the two fingerprints (and so the two `defaultAvatarOption` results, per
  2d) never collide even though they share one owner.

`owner.id` is a random 16-byte public id created once at onboarding - never a device key, never a
box key, and never a secret (the same status the fingerprint itself already has, per section 3).
The `"v1:"` segment versions the derivation itself, so a future change to how the fingerprint is
computed can't silently collide with today's ids.

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

### 5. Skin-tone legibility on the teammate family, locked (28 Sep, user's decision)

User's decision, verbatim: "lock on avatars, but some of them were getting too dark skin colors
and so they weren't clearly visible, so fix that and then lock it." Scoped first: only the
teammate family (round3b/original.js's `character()`) draws a real skin tone - the person and
assistant families (section 1) use an abstract warm gradient and a luminous mark, never a skin
representation, so neither had this problem or needed a change. Agent blobs draw from a separate
pastel palette, also unaffected.

Measured, not guessed, using WCAG contrast ratio on the actual hex values already in the code
(`round4/identity.js`'s `SKIN_TONES`, light to deep): two independent legibility failures, not
one.

1. **Feature ink on skin.** Eyes, mouth and glasses were a single fixed near-black
   (`#141311`) regardless of skin tone. Against the three deepest tones that measured
   1.30-2.60:1 - the features were disappearing into the head, not just reading "dark," on
   every surface and every theme, independent of backdrop.
2. **Skin against its backdrop.** A teammate's head sits directly on whatever the surface
   supplies - an `--hover` tile in a list row, or bare on `--panel`/`--bg` in a chat avatar
   (no wrapping box of its own). Checked against the real system backdrops
   (`avatar-showcase/build.js`'s tokens): the four deepest tones measured 1.15-3.94:1 against
   dark theme's backdrops, and, less obviously, **the four lightest tones measured 1.05-2.89:1
   against paper theme's** - both ends wash out, in the theme where their end of the range sits
   closest to the backdrop. Fixing only the dark end would have shipped a paper-theme version of
   the same bug at the light end.

**The range itself does not change.** All 8 tones (`#FBE0C6` through `#3E2417`) stay exactly as
they were; nothing was removed, narrowed or lightened. Both fixes are additive, computed from the
skin tone rather than hand-picked per tone, and live in `round4/identity.js` as the one shared
identity module (not duplicated into `round3b/original.js`, which now imports them):

- **`featureInkFor(skinHex)`** returns `DARK_INK` (`#141311`) wherever that clears a 3:1 floor
  against the skin, and `LIGHT_INK` (`#F1EEE6`, the same cream `creature.js` already uses for its
  eye sparkle) only on the tones dark enough that dark ink no longer would. A given skin tone
  always gets the same ink; a reroll of everything else on a teammate never flips its own feature
  colour on its own.
- **`rimFor(skinHex, theme)`** returns a thin ring (stroke-width 3, drawn at r=28.5 just inside
  the head's own r=30 edge, so it reads as the head's boundary rather than a floating halo) when,
  and only when, that skin tone fails the 3:1 floor against any backdrop in that theme - `null`
  otherwise, so a tone that already reads fine gets no added ring. The ring colour is the theme's
  own contrasting ink, opposite of the theme's ordinary text colour on a light-vs-dark call: light
  cream at 0.55 opacity in dark theme, dark ink at 0.6 opacity in paper theme. Both opacities carry
  a real margin over their minimum (0.4 and 0.5 respectively, per the tuning pass in
  `round4/identity.js`'s comments) - worst case lands at 5.2:1 and 4.6:1, not sitting on the floor.
- **`validatePalette()`**, next to `validateGeometry()`'s existing contract, checks every one of
  the 8 skin tones against every backdrop in both themes (24 combinations) plus its own derived
  feature ink, and throws with the specific failing combination if a future edit to `SKIN_TONES`,
  the inks, the rim or the backdrops regresses any of them below the 3:1 floor. Run after editing
  any of those. Currently: 48 checks (8 tones x 2 themes x 3 backdrops), all pass, worst case
  3.68:1.

`character()` gained a third parameter, `theme` (default `"dark"`, matching `vyrecode2.js`'s own
convention), so it can pick the right rim. **This is the real integration contract**: a caller
renders per the live theme at draw time, the same way the person's circle and the Vyre code
already do - the static SVGs `round4/export.js` writes to `round4/svg/` for the design canvas are
a single-theme snapshot (baked at `"dark"`) for that canvas's own use, not a second product path,
and were not re-baked per theme here since nothing in that canvas consumes them per-theme today.

Verified visually, not just by the numbers: a contact sheet rendered with headless Chrome
(`round3b/contact-sheet-fix.js` -> `.html` -> `.png`, temp Chrome profile, no visible window) shows
all 8 tones, both themes, against both the `--panel` and `--hover` backdrop, with the ink and rim
each tile actually used labelled underneath it. Every tile reads clearly: no head blends into its
backdrop, no feature disappears into its skin, in either theme. The full `avatar-showcase`
(`showcase.html`, rebuilt from the fixed `character()`) confirms the same in context - the
teammates panel, the chat thread's handoff rows, and the side list all read cleanly across the
whole range, and the Vyre code pair at the bottom is visually and numerically unchanged
(`validateGeometry()` still passes at margin 51px/8.5%, gap clearance 7px, matching 2b's numbers
exactly - this round touched no geometry).

**Locked.** No further changes to the teammate family's skin-tone handling without reopening this
section.

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
- `round4/identity.js` now also carries `SKIN_TONES`, `featureInkFor()`, `rimFor()` and
  `validatePalette()` (section 5) - the equivalent enforcement point for skin-tone legibility.
  `round3b/original.js`'s `character()` imports these rather than restating them, and takes a
  `theme` param so callers render per the live theme, same convention as `vyrecode2.js`. `native-core`
  should import `character()`/`blob()` (and `identity.js`'s exports) from
  `deck/vendor/avatars/round3b/original.js` and `deck/vendor/avatars/round4/identity.js` rather
  than hand-copying values, for the same reason geometry.js is vendored, not restated.
