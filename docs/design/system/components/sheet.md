---
title: Sheet
summary: The phone bottom sheet with a grabber and a scrim, which becomes a centred card or a right sheet on the desktop.
audience: builders
owner: app-design
status: draft
---

# Sheet

A sheet holds a focused task over the page: a Needs you detail on the phone, the Places sheet,
the mode picker on the phone, an import, Add your phone. The same component is a bottom sheet
under 720 and a centred card or a right sheet above. Drawn on the boards "Vyre one app, layout"
(Places), "Plan approval and modes, phone and desktop", "Vault, phone and desktop", "Presence,
sign in once, prove it rarely" and "Install 1, add your phone from the laptop" (centred).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/sheet.js`, `deck/css/sheet.css`, `deck/js/need-sheet.js` (work/pwa) | built |
| App | none (Places is a modal screen, `apps/app/app/places.tsx`) | not built |
| Capsule | not used | |

## Anatomy

**Phone (under 720).**
1. **Scrim.** Covers the page, `--scrim`. Tap closes.
2. **Sheet.** Anchored to the bottom, left and right 0, top at its detent. Fill `--panel`, radius
   `--radius-sheet` (14) on the top corners only, shadow `--float`, 1 px `--rule` top border.
3. **Grabber.** 36 by 5, radius 3, `--rule-strong`, 6 from the top, centred, in a 16 tall drag
   area.
4. **Header.** Padding 10 8 6 16: title 22/28 600 (`t22`) and an optional subtitle 13/18
   `--text-2`, then a close icon button (20 icon in a 44 target) on the right.
5. **Body.** One inner scroller, `overscroll-behavior: contain`, padding 0 16 16.
6. **Actions** (optional). Stacked, gap 8, padding 12 16 and the bottom safe area, `--rule` top
   border: the one primary at 54 (`--control-touch-lg`, radius 12), others at 44.

Detents: fit content, up to the top safe area plus 10. A tall sheet starts at about 60% and drags
up to full.

**Desktop (720 and up).** Two shapes, same content and roles:
- **Centred card** for a task that ends (Add your phone, import, a detail opened from a push):
  width 540 (560 for a detail, up to 1160 for a stepper flow), top 56, radius `--radius-card`
  (12), fill `--panel`, shadow `--popover`, scrim `--scrim`. No grabber; the close button top
  right at 32.
- **Right sheet** for a detail beside the list (a device, a setting's rules): width 340 (the
  side panel width) to 480, full height under the top bar, 1 px `--rule` left border, no scrim,
  no radius. The page stays usable.

## States

- **Opening, closing.** See Motion. The page behind is inert while a modal sheet is open.
- **Dragging** (phone). Follows the finger with no transition; release past a third of its
  height, or a downward fling, closes.
- **Keyboard up** (phone). The sheet stops at the keyboard's top edge; actions sit on it.
- **Stacked.** A sheet over a sheet: only the innermost hears Escape and keeps focus.

## Keyboard and touch

Escape closes; focus moves into the sheet (to `autofocus` or the sheet), is trapped there, and
returns to the opener on close. Phone: swipe down on the grabber or header closes; tap on the
scrim closes; the body scrolls without moving the sheet until it is at the top.

## Motion

Open: `transform: translateY(100%)` to 0 over `--motion-sheet` (280), `--ease`; the scrim fades
in over the same 280. Close: the reverse over `--motion-panel` (220). Centred card: opacity and
scale 0.98 to 1 over 220. The page behind does not move or scale. Reduced motion: opacity only,
200.

## Copy

Titles name the task or the item: "Mode", "Import from 1Password", "Add your phone", "Send email
to Sam". Close is an icon with the accessible name "Close". Never "Cancel" as the only way out
of a sheet that changed nothing.

## Accessibility

`role="dialog"`, `aria-modal="true"`, labelled by its title. The grabber and scrim are
`aria-hidden`; the close button is the accessible way out. Safe areas: `env(safe-area-inset-*)`
on the actions and the sides in landscape.

## Gaps

Deck (work/pwa)
- [ ] Motion is 340 in and 240 out on a custom curve; use `--motion-sheet` and `--motion-panel`
      with `--ease`.
- [ ] The page behind scales to 0.94 over black; remove, the scrim is enough.
- [ ] `--scrim` and `--float` are redefined in sheet.css; read the tokens.
- [ ] Desktop is always the 560 centred card; no right sheet. Buttons are `.sb` at 46 and 54
      with opacity for disabled; use the button spec.
- [ ] Title is 26/32; use 22/28.

App (work/mobile)
- [ ] No sheet: Places is a modal screen and Needs detail is a pushed screen; build the bottom
      sheet on Reanimated with the same detents.
