---
title: Toast
summary: The one undo toast, 4 s, that follows every optimistic answer, removal or reset, in the row's place or floating above Lumen.
audience: builders
owner: app-design
status: draft
---

# Toast

Every optimistic action that can be taken back leaves one undo toast for `--motion-undo` (4 s):
a swiped answer, a discard, a removed rule, a forgotten memory, a sent draft. There is one toast
at a time and it only ever offers Undo while Undo can still work. Drawn on the boards "Needs you,
teammate kinds" (in place), "Presence, sign in once, prove it rarely" ("Sent to Sam"), "Projects,
phone and desktop" and "Memory, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/now-phone.js`, `deck/css/views/now.css` `.np-toast` (work/pwa); `deck/css/views/vault.css` `.vt-toast` (main) | partial |
| App | `apps/app/src/ui/UndoToast.tsx` (work/mobile) | built |
| Lumen | none | not built |

## Anatomy

Two placements, one look:

1. **In place.** When a row collapses, the toast takes the row's slot: height 44, padding 0 14,
   gap 10, fill `--hover`, `--rule` top border. A 16 check icon in `--text-2`, the words in base
   size `--text` (one line, ellipsis), then "Undo" in base 600 `--text`.
2. **Floating.** When there is no row to hold it (a send from a sheet, a reset elsewhere): fixed,
   16 from the sides on the phone and 24 above Lumen (above the safe area), bottom centre at
   max width 480 on the desktop. Min height 44 (`--control-touch`), padding 0 6 0 16, radius
   `--radius-card` (12), fill `--panel`, 1 px `--rule-strong`, shadow `--float`.

Undo is a ghost button: `--text`, 600, 44 tall on touch, 28 on the desktop. It is never bone and
never primary. Optional countdown: meta size `--label` "4 s" after Undo (drawn on the Presence
board), counting whole seconds.

## Sizes

Phone words 13/18 (drawn) to 17/24 floating; desktop 13/18. The toast never wraps; long words
truncate.

## States

- **Shown.** From the frame of the commit. The action waits in the outbox until the 4 s end.
  Every undo is 4 s, Discard included (the Needs board's note "an undo for 10 s" is superseded).
- **Undo.** Cancels the waiting call; the row comes back in its place (or the value returns), the
  toast closes at once. No second toast.
- **Next commit.** A new toast replaces the old one; the old action sends at once (it is flushed,
  not dropped).
- **Leaving the page or backgrounding.** Waiting actions flush and send; the toast closes.
- **Refused after the 4 s.** No toast: the row returns with its refusal (see the needs-row spec).
- **Hover** (desktop) pauses the countdown; it restarts at 2 s when the pointer leaves.

## Keyboard and touch

⌘Z (Ctrl+Z) triggers Undo while a toast is up, on the desktop. The toast never takes focus. On
the phone Undo is a 44 target; the rest of the toast passes touches through.

## Motion

In: opacity and 8 px up over `--motion-panel` (220), `--ease`. Out: opacity over `--motion-tap`
(120). In place, the toast appears as the row's height collapses into its 44 slot. Reduced
motion: opacity only.

## Copy

Past tense, what happened, then Undo: "Approved", "Denied", "Discarded", "Sent to Sam", "Hidden
here for an hour", "Added intake to Northwind Bakery", "Removed npm run lint", "Reset to
Account". Never "Success!", never "Action completed", never an exclamation mark. A destructive
removal with no undo (removing a device, a hold) shows no toast.

## Accessibility

`role="status"`, `aria-live="polite"`; the words are announced, then "Undo, button". The 4 s is
extended to 10 s when a screen reader or switch control is on, so Undo stays reachable.

## Gaps

Deck (work/pwa, main)
- [ ] Two toasts: `.np-toast` on Now and `.vt-toast` in the vault; make one shared toast.
- [ ] No in-place variant; an approve's toast has no Undo (the answer goes at once).
- [ ] Toast shadow is `--light-top`; use `--float`. Words 15/20; use the type steps.

App (work/mobile)
- [ ] Undo text is `--focus` (bone); use `--text`, 600.
- [ ] Floating only; no in-place variant; no ⌘Z on the web build.

Lumen (work/capsule-pro)
- [ ] No toast: add the floating variant under Lumen's list for answers given there.
