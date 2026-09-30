---
title: Popover
summary: Menus and pickers that open from a control, the mode popover, the @ file picker, the / command menu and row menus, which become a sheet on the phone.
audience: builders
owner: app-design
status: draft
---

# Popover

A popover is a small floating panel anchored to the control that opened it: the session mode
menu, the @ file picker, the / command menu, the rewind list, the send menu (Steer now, Queue for
after), a row's More menu. Under 720, a popover with more than a short list of choices opens as a
sheet instead. Drawn on the boards "Session · the composer, like Claude Code" and "Plan approval
and modes, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/pickers.js` `.composer-menu`, `.cv-rewind` (main, work/chat); `deck/css/deck.css` `.search-pop` | built |
| App | none | not built |
| Lumen | `local/capsule/native/Sources/UI/AgentDeskView.swift` ActionMenuView; `Host/MenuBarItem.swift` MenuBarPopover (work/capsule-pro) | partial |

## Anatomy

1. **Panel.** Fill `--panel`, 1 px `--rule-strong` border, radius `--radius-card` (12), shadow
   `--popover`, `overflow: hidden`. Width by content: 250
   (send menu), 330 (mode), the composer's width minus 40 (command and file pickers).
2. **Header** (optional). Height 40 (24 to 34 in dense pickers), padding 0 14 (12 dense): label
   12/600 `--label` ("Mode for this session", "Files in harlow-legal", "Rewind to an earlier
   message") and a hint right (key-hint chip "⇧Tab" and "cycles", or "recent first").
3. **Group label** (optional). Height 24, padding 0 12, 12/600 `--label` ("Built in").
4. **Items.** Separated by a 1 px `--rule` top border in descriptive menus, none in dense pickers.
   - Dense picker row: height 28 (commands) or 30 (files), padding 0 12, gap 12: mono 13 name
     (`/compact`, `src/intake/estate.ts` with the match in 600), description 13 `--text-2`
     truncating, meta right.
   - Descriptive row: padding 9 14, gap 10, align start: 16 icon, title 13/600 and a one-line
     description 12 `--text-2`, a mono tag right (`plan`, `acceptEdits`), and a 16 check in
     `--focus` on the current one (a 16 spacer on the others, so text aligns).
5. **Footer** (optional). Padding 10 14 12, `--rule` top: a note or a toggle ("Trusted project").

## Variants

- **Menu** (actions): row menus, the ⌘K actions list.
- **Picker** (choose a value): mode, provider, model. Current value has the check.
- **Completion** (type to filter): / commands, @ files. The first row is active by default.

## Sizes

Desktop rows 28 to 40. Max height 360; the list scrolls inside with the header fixed. The panel
keeps 8 from the viewport edges and flips above or below its anchor to fit.

## States

- **Active row** (keyboard or hover): fill `--signal-wash`; meta on it steps up to `--text-2`.
- **Current value:** the bone check, never a fill.
- **Disabled item:** `--label` text, no hover, with a reason in its description.
- **Empty completion:** one row in `--label`: "No files match est".
- **Loading:** two skeleton rows at the row height.

## Keyboard and touch

↑ and ↓ move the active row, Enter or Tab picks, Escape closes and returns focus to the anchor.
A completion keeps focus in the composer (`aria-activedescendant`). Type-ahead in menus jumps to
the first match. On the phone, the mode picker and the send menu open as a sheet with 44 or 56
rows (see the sheet spec); completions stay a popover above the keyboard with 44 rows.

## Motion

Open: opacity and 4 px toward the anchor over `--motion-tap` (120). Close: opacity over 120.
Reduced motion: opacity only.

## Copy

Mode names: "Plan first", "Asks first", "Edits allowed", "Doesn't ask", each with a one-line
description ("Reads and proposes. Changes nothing."). Sentence case headers; mono only for
commands, paths and ids.

## Accessibility

Menus: `role="menu"` and `menuitem` (or `menuitemradio` with `aria-checked` for pickers).
Completions: `role="listbox"` and `option` with `aria-selected`, owned by the input. The anchor
has `aria-haspopup` and `aria-expanded`.

## Gaps

Deck
- [ ] `.composer-menu` and `.cv-menu` rows use their own sizes; align to 28 and 30 dense rows.
- [ ] No mode popover with descriptions yet; mode labels read "Accepts edits" and "Plan mode".

App (work/mobile)
- [ ] No popover or picker: mode is plain text in `app/session/[id].tsx`.

Lumen (work/capsule-pro)
- [ ] ActionMenuView has a caps title with tracking and a 2 px `Theme.signal` left bar on the
      active row; use the `--signal-wash` fill and a 12/600 sentence-case header.
