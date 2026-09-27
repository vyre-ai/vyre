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
