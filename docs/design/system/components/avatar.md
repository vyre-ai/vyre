---
title: Avatar
summary: The agent tile (an initial in a rounded square) and the person avatar (an initial in a circle), in four sizes.
audience: builders
owner: app-design
status: draft
---

# Avatar

A small neutral tile that says who: an agent (kit, juno, design) or a place as a rounded square,
the person (alex) as a circle. It sits at the start of rows, in detail headers, and as the
person's button to Places. Drawn on almost every board; see "Agents and their computers",
"Agents place, teammates" and "Needs you, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.initial` `.avatar` (main); `deck/chat/chat.css` `.av-agent` `.av-person` (work/chat); `deck/css/sheet.css` `.nsh-tile` (work/pwa) | partial |
| App | inline in `apps/app/src/ui/Row.tsx` and `apps/app/src/ui/Screen.tsx` (work/mobile) | partial |
| Capsule | none (work/capsule-pro) | not built |

## Anatomy

- A box with fill `--hover`, no border, ink `--text`, content centred.
- Content is one of:
  - **Initial**: the first letter of the name, lower case as the name is written (kit is "k",
    juno is "j", alex is "a"), Instrument Sans weight 600.
  - **Icon**: a 16 icon from the set in `--text-2` for a place, device or kind (vault, devices,
    box, phone, laptop, projects). Tile shape only.
- **Agent tile**: radius = size / 4. **Person avatar**: radius `--radius-full` (a circle).
- **Mark overlay** (optional): a status mark at the bottom right, offset -2, on a 2 px ring of
  the surface colour (see status-mark).

Agents, teammates (kit, design) and places get tiles; only the person gets a circle. There are no photos, and no
colour per agent or person.

## Four identity families (ADR 0043)

Generated-avatar work (`docs/work/app-design.md` rounds 1-5) grew the tile/circle split above
into four families, each with its own silhouette so identity reads before the name or initial
does:

| Family | Shape | Content |
|---|---|---|
| Person (you) | True circle | A warm two-tone gradient, a calm face, no hair or accessory - one identity, never a rolled character |
| Assistant | Companion creature | A plump rounded body, glow halo, small ears, a curled tail, a sparkle-eyed face - its own species, not an agent in a different pose |
| Agent | Organic blob | A spikier, more angular wobble; a plain dot-eyed face |
| Teammate | Rounded-square tile | This section's existing tile: initial, or a rolled character with role prop |

Agent and assistant marks draw from separate palettes on purpose, so a colour coincidence never
makes one read as the other. Full rationale and sources: ADR 0043.

## Skin-tone legibility, locked (ADR 0043 section 5)

The teammate family's rolled character (`round3b/original.js`'s `character()`) is the one family
that draws a real skin tone - 8 tones, light to deep, `round4/identity.js`'s `SKIN_TONES`. Person
and assistant use an abstract gradient and a luminous mark instead, never a skin representation,
so neither needed a change here.

User's decision (28 Sep): some avatars' skin tones were too dark to read clearly - fix the
legibility, keep the full range. Measured as two separate failures (not one): the fixed near-black
feature ink (eyes, mouth, glasses) disappeared into the three deepest tones (1.3-2.6:1), and the
head itself washed into its backdrop at both ends of the range in the theme where that end sits
closest - the four deepest tones against dark theme, the four lightest against paper theme
(1.05-3.9:1 across both). Fixed at the source, in `identity.js`:

- `featureInkFor(skinHex)` - dark ink wherever it clears 3:1 against the skin, a light cream ink
  only where it doesn't. Deterministic per tone, never per-seed.
- `rimFor(skinHex, theme)` - a thin ring just inside the head's edge, only on tones that fail 3:1
  against that theme's backdrops, coloured from the theme's own contrasting ink.
- `validatePalette()` - checks all 8 tones x 2 themes x 3 backdrops (24 combinations) plus each
  tone's own feature ink, throws on any regression below the 3:1 floor. 48 checks, all passing,
  worst case 3.68:1.

`character()` takes a `theme` param (default `"dark"`) so a caller renders per the live theme -
the real integration contract, same convention `vyrecode2.js` already uses. Verified visually with
a headless-Chrome contact sheet across all 8 tones, both themes, both `--panel` and `--hover`
backdrops (`round3b/contact-sheet-fix.png`) and in the full `avatar-showcase` in context. Locked:
no further change to this without reopening ADR 0043 section 5.

## The Vyre code (ADR 0043)

The person's circle above has a second, full-size form for pairing and identity-sharing: a ring
of marks around the same face and palette encoding a public id/ticket (never a secret), scanned
by Vyre's own decoder rather than a generic QR reader. Geometry, palette derivation and the
pairing contract are specified in ADR 0043; implementation lives in `round5/vyrecode2.js`
(rendering) and `round5/decode-core.js` + `rs.js` (decode). Not yet wired into product surfaces.

## Avatar option: default from identity, optional pick (ADR 0043)

Person and assistant avatars (round4/identity.js) each have a small number of visual options
(gradient/face variation). Ruling (lead, 28 Sep): the **default is derived deterministically
from the identity's own 8-byte public fingerprint** (the same fingerprint the Vyre code encodes,
never a secret) - `defaultAvatarOption(fingerprint, optionCount)` = the fingerprint's first byte
mod the option count. Every person and every assistant gets a unique, stable avatar with zero
setup, "unique by design" - never a hash of a device or box key, which is a different, unstable
identity. A **stored pick is optional and overrides the default**; only the person themself can
set their own, and only ever their own. Not yet built: see Gaps.

**Teammates specifically** (ADR 0031, `docs/work/teammates.md` section 3, decided with teammates
and chat 2026-09-28): a teammate's tile is the same neutral agent tile as any other agent, initial
lower case, `--hover` fill, no per-teammate hue. Considered and turned down: a role-hashed accent
colour (a coloured disc, a 3 px left border on bubbles, a coloured dot in rows). `docs/design/
one-app/README.md`'s System section already draws this line for the whole product: "lime for
action, focus, running and selection, violet for needs you (teal the one alternative). No other
hue. Devices and hosts never get a colour." A teammate is exactly this kind of entity, not a
person, and giving each one its own hue would be the first crack in a rule that's held since
Design A: reads well on day one with three teammates, badly once a project has eight. The name
next to the tile is already how kit and juno are told apart today; a teammate needs nothing more.
Distinct-in-chat instead comes from the author line itself (turn.md) plus the handoff card
(tool-row.md, "Handoff" variant): a session asking a teammate is its own visible row, named by the
teammate's role, not a colour to memorize. Made concrete (lead, 2026-09-28, distinct must still
read without colour):

- **The tile is never shown bare.** Wherever a teammate's tile appears (the handoff card, its row
  in the Agents place, its thread header), the role name sits directly beside it in text, same
  size and weight as any agent's name elsewhere (turn.md's author line, list-row.md's title): "design",
  not an icon or initial standing alone that a person has to have memorized.
- **A "Teammate" tag** (chip.md, a Tag: `--hover` fill, no border, 12/16 `--text-2`, no icon) sits
  after the role name in exactly those three places: the handoff card's own line, the Agents place
  row, and the top of the teammate's own thread pane (Now/Inbox/Results/Notes/Setup, ADR 0031
  section 9). This is what separates "design, a persistent project teammate" from a one-off
  sub-agent or the person's own assistant at a glance, in words, not a hue. It never appears twice
  in the same row (the thread header shows it once at the top, not again per turn inside it).
- **The handoff card is never hidden and never folds into a run.** Tool-row's "folded run" (a
  sequence of ordinary tool calls collapsing into one summary line) never absorbs a Handoff row,
  the same exemption tool-row.md already gives a plan or a todo list. It always renders as its own
  line, collapsed (the reply detail closed) by default, exactly the "→ Asked design ..." shape
  teammates.md proposed; "collapsed" only ever means the reply is folded shut, never that the row
  itself is missing from the flow.

**One narrow exception: the CLI.** `vyre team list` and `vyre team` output <!-- terms: ignore -->
may colour a teammate's name with a role-hashed ANSI 256 colour, the way `git log --graph` colours
branches: text-only,
degrades to plain text under `NO_COLOR`, chosen from a fixed set of about 8 pre-picked, AA-tested
hues (never an arbitrary hash-to-hue) so a hash never lands near lime (`2` in the xterm 256 sense)
or violet, which would misread as a status signal in a terminal. This stays a CLI-only convention;
it does not leak into the Deck, the App or the Capsule, where the rule above holds without
exception.

## Variants

| Variant | Shape | Content |
|---|---|---|
| Agent | Rounded square | Initial |
| Place or kind | Rounded square | Icon |
| Person (you) | Circle | Initial |

## Sizes

| Size | Radius (tile) | Text | Where |
|---|---|---|---|
| 20 | 5 | meta 12/16 | Mac Capsule rows |
| 24 | 6 | meta 12/16 | Desktop list rows, inline mentions |
| 32 | 8 | base 13/18 | Phone rows, rail foot (person) |
| 40 | 10 | read 15/22 | Detail headers, device and place rows |

The phone header's person avatar is 34 visible inside a 44 hit target. Nothing else in between.

## States

- **Default.** `--hover` fill.
- **On a selected row** (`--signal-wash`). Unchanged; the tile stays neutral.
- **On `--hover` surfaces** (a card already on hover). The tile fill steps to `--panel`.
- **Person avatar as a button** (the phone header, the rail foot): hover `--rule` fill, focus
  ring 2 px `--focus` offset 2, pressed `--rule` fill. It opens Places on the phone.
- **Unknown** (no name yet). The tile shows the agents icon; the person avatar shows the person's
  first letter from the box, never a placeholder "?".

## Keyboard and touch

Plain avatars are not interactive; the row is. As a button: Tab to it, Enter or Space opens; on
touch the hit target is 44.

## Motion

None.

## Copy

The initial is derived, never typed. Names stay in their written case in text beside it ("kit ·
Harlow Legal"). Never a nickname or emoji in the tile.

## No AI-brand lookalikes

Applies to all four families above, and to the Vyre code's ring marks - not only the assistant's
mark. Any generated mark drawn for an identity here must not resemble a major AI brand's own
mark: Gemini's four-point sparkle, Claude's starburst, OpenAI's knot, Copilot's shape,
Perplexity's compass-like glyph.
Checked before each round of generated-avatar work ships, not just once: a direction that reads
fine alone can still land on a lookalike once it's redrawn or recoloured. (User, 2026-09-28: the
first assistant mark round read as Gemini's sparkle; dropped for that reason, not a licence one,
since it was original artwork.) This is a design review step, not a licence check, and applies
whether or not the artwork itself is original.

## Accessibility

- Decorative next to the printed name: `aria-hidden="true"`.
- Alone (the header button): `aria-label` "Places, alex" on the phone, "alex" on the desktop.
- Initial ink `--text` on `--hover` passes AA in both themes; icon ink `--text-2` passes 3:1.

## Gaps

- [ ] Deck: `.initial` is 24 with a `--rule-strong` border, JetBrains Mono 11 weight 500; use the
  sans initial, no border, meta 12/16 weight 600.
- [ ] Deck: `.avatar` (the person) is 28, mono 11 with letter spacing, bordered; use 32 or 34
  circle, sans, no border.
- [ ] Deck (work/chat): `.av-agent` is 28 with `--r-2` and a border; `.av-person` is 28. Neither
  size is in the scale.
- [ ] Deck (work/pwa): `.nsh-tile` is 22 with radius 6; use 24 with radius 6.
- [ ] App: the agent tile is a circle (`radius.full`) with `--text-2` ink at 32; it needs the
  rounded square and a shared `Avatar` component with the four sizes.
- [ ] Capsule: no avatar; the Capsule board draws 20 tiles with radius 5.
- [ ] The optional stored-pick override (see "Avatar option" above) has no real field yet -
  `onboard.person.avatarOption` or similar, written only by the person, read by every surface
  that draws their avatar including the phone's pairing screen. Not needed for 0.1.1: every
  surface can compute the deterministic default from the fingerprint alone until this exists.
  `anywhere` (core/onboard) builds it later. `tailnet` puts the identity fingerprint in the
  verified ticket record now, and will carry the pick alongside it once the field exists.
