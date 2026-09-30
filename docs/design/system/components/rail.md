---
title: Rail
summary: The 72 px icon rail with labels that holds every place on tablet and desktop widths, with the Now count badge.
audience: builders
owner: app-design
status: draft
---

# Rail

The rail is the place switcher from 720 px up: a 72 px column of icons with their labels, the
current place filled, and the Needs you count on Now. Under 720 the phone shell takes over. Drawn
on the boards "Needs you (home)", "Agents and their computers", "Planner", "Add your phone" and
"Layout".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/app.js`, `deck/css/deck.css` (main) | partial |
| App | none in `apps/app` (work/mobile) | not built |
| Lumen | not used | not used |

## Anatomy

1. **Column.** Width 72, full height, `display: flex` column, items centred, padding 12 top and
   bottom, gap 2, right border 1 px `--rule`, background `--bg`.
2. **Home mark.** 40 by 40 hit area, radius 10, mark drawn at 22, margin 10 below. The mark's wire
   is `--mark-wire`; its dot is `--mark-dot`, and `--beacon-dot` while anything needs you.
3. **Place button.** 60 by 50, radius 10, column, centred, gap 4 (the board draws 3): icon 20 on
   the 16 grid, then the label at meta size (12/16), 400.
4. **Count badge.** On Now only. Absolute, top 4, right 8 (board: 3 and 8). Min width 18, height
   18, radius 9, padding 0 5, fill `--beacon-dot`, text `--beacon-badge-ink` 12/16 600. Caps at
   "99+". Hidden at 0.
5. **Order, top group:** Now, Chat, Agents, Projects, Planner, Memory, Vault.
6. **Modules group (later).** Under Vault, after a 1 px `--rule` hairline with 8 above and below:
   up to 3 pinned modules, same place button (ADR 0033, proposed; not drawn yet).
7. **Bottom group** (pushed down with `margin-top: auto`, gap 2): Devices, Settings, then the
   person avatar (circle, 32, initial at 13/600 on `--hover`), 8 above it.

## Sizes

One size. The rail never collapses to icons only and never widens to text rows. It shows at every
width from 720; list and detail sit to its right (see phone-shell for the breakpoints).

## States

| State | Fill | Icon and label |
|---|---|---|
| Default | none | `--label`, 400 |
| Hover | `--hover` | `--text` |
| Current | `--hover` | `--text`, label 600; `aria-current="page"` |
| Focus (keyboard) | as above | 2 px `--focus` outline, offset 2 |
| Pressed | `--hover` | `--text` (no scale) |

- The badge is the only colour in the rail. No bone on the current place, no left bar, no pill.
- Needs you empty: no badge, and the home mark's dot returns to `--mark-dot`.
- Offline: the rail does not change; the offline pill says so (see states).

## Keyboard and touch

- ⌘1 to ⌘9 open the places in rail order: Now 1, Chat 2, Agents 3, Projects 4, Planner 5,
  Memory 6, Vault 7, Devices 8, Settings 9. Modules take no number.
- Tab reaches each place in order; Enter or Space opens it.
- On touch (an iPad at 720 and up) each button is 60 by 50, over the 44 minimum.
- The avatar opens the account menu (name, the box address, sign out); proposed, not drawn.

## Motion

Hover and current fills change over `--motion-tap` (120 ms) with `--ease`. Nothing slides between
places. The badge count changes in place, no bounce. Reduced motion: no transition.

## Copy

- Labels exactly: Now, Chat, Agents, Projects, Planner, Memory, Vault, Devices, Settings.
- The rail says "Chat"; the phone's page label says "Chats". Both are right for their shape.
- Never: Home, Inbox, Dashboard, Sessions, Threads, or any caps label.

## Accessibility

- `nav` with `aria-label="Vyre"`; the mark is a link with `aria-label="Vyre home"` to Now.
- Each place is a link with its visible label as the name. Now with a count reads "Now, 5 need
  you" (`aria-label`); the badge itself is `aria-hidden`.
- `--label` on `--bg` passes 4.5:1 at 12 px in both themes; the badge ink on `--beacon-dot` passes
  4.5:1 at 12/600.
- The avatar has `aria-label="Account"` and the person's name as its title.

## Gaps

Deck (main)
- [ ] The rail is 216 px with text rows 34 tall at 14 px, not the 72 px icon rail.
- [ ] Order is Now, Projects, Memory, Agents, Chat, Vault, Settings; Planner and Devices are missing.
- [ ] The count is violet mono 11 px text, not the 18 px badge; no 99+ cap.
- [ ] Brand sits in the top bar (`.brand`, 216 wide) instead of the mark at the top of the rail.
- [ ] Uses raw `--r-2` radius and the old `--beacon-wash` elsewhere in the shell.
- [ ] No ⌘1 to ⌘9 place keys.

App (work/mobile)
- [ ] No rail at 720 and up; tablets get the phone tab bar.
