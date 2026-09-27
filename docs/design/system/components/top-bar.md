---
title: Top bar
summary: The 56 px bar over every desktop page, with the page title on the left, the command bar in the centre and one right slot.
audience: builders
owner: app-design
status: draft
---

# Top bar

The top bar names the page, holds the ⌘K command bar, and carries one thing on the right: a
status, the needs count, or the page's primary action with its key. It sits over the list and
detail from 720 px up; the phone uses its own header (see phone-shell). Drawn on "Needs you
(home)", "Agents and their computers", "Planner" and "Add your phone".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/app.js`, `deck/css/deck.css` (main) | partial |
| App | `apps/app/src/ui/Screen.tsx` (work/mobile), phone header only | not built |
| Capsule | not used | not used |

## Anatomy

1. **Bar.** Height 56, grid of three columns `minmax(0, 1fr) 440px minmax(0, 1fr)`, gap 16,
   padding 0 20 0 28, bottom border 1 px `--rule`, background `--bg`. It spans the main area
   right of the rail, not the rail.
2. **Left: title.** The page name at 15/22 600 `--text` (an `h1`), gap 10, then one meta line at
   12/16 `--label` that truncates: "Good afternoon, alex" on Now, "3 agents · 2 computers" on
   Agents, "Monday 28 Sep" on Planner, "4 yours and the relay" on Devices.
3. **Centre: the command bar trigger** (see command-bar).
4. **Right slot**, right-aligned, gap 8. Exactly one of:
   - **Status**: a status mark and 12/16 `--text-2` ("direct 12 ms", "Google · work synced 2 min
     ago"), optionally with one segmented control (Planner: Day, Week).
   - **Needs count**, on any page but Now while something waits: 32 tall, padding 0 10, radius
     `--radius-button`, the needs dot then "5 need you" at 13/600 `--beacon-ink`. Hover `--hover`.
     Opens Now.
   - **Page primary with its key**: a 32 button with its key hint inside ("Add your phone N"). If
     the detail pane already has the surface's primary (Glass: Take over), this is an outline
     button ("New agent N"). One primary per surface.

## Sizes

One height, 56. Between 720 and 1099 the centre column narrows to `minmax(240px, 440px)` and the
meta line hides first, then the placeholder truncates (proposed; the boards draw 1280 only).

## States

| Part | Default | Hover | Focus |
|---|---|---|---|
| Needs count | `--beacon-ink` text, no fill | `--hover` fill | 2 px `--focus` outline |
| Right button | per button spec | per button spec | 2 px `--focus` outline, offset 2 |

- Loading: a 14 px spinner may sit after the title (States board, "Chat · first 10 s").
- Offline: the right slot shows the status "offline" with a `--label` dot; the pill carries the
  rest (see states).
- Many items: the title's meta becomes the exact count ("128 · oldest first"); filter chips may
  sit in the right slot on Needs you.

## Keyboard and touch

- ⌘K focuses the command bar from anywhere.
- N runs the page primary shown in the right slot. The key shows inside the button.
- The title is not interactive.

## Motion

None on the bar. The needs count appears and disappears without animation so the right slot never
shifts; reserve its width while the page is Now (the slot is empty there).

## Copy

- The title is the rail label, except Now's list heading may say "Needs you" when filtered.
- Needs count: "1 needs you", "5 need you", "99+ need you".
- The greeting shows on Now only: "Good morning, alex", "Good afternoon, alex" or "Good evening, alex".
- Never "Dashboard", "Home" or an exclamation mark.

## Accessibility

- `header` landmark; the title is the page's only `h1`.
- The needs count is a link named "5 need you, open Now".
- The right-slot button carries `aria-keyshortcuts` for its key ("N").

## Gaps

Deck (main)
- [ ] Bar is 48 tall, flex not the three-column grid; brand and the box address sit on its left.
- [ ] No page title in the bar; views draw their own headings.
- [ ] The search field is 420 wide inside the bar, not the centred command bar trigger.
- [ ] The needs pill uses `--beacon-wash` fill and a pill shape; spec is text in `--beacon-ink` on no fill.
- [ ] No right-slot page primary with N.

App (work/mobile)
- [ ] No desktop or tablet top bar; `Screen` draws a phone title only.
