---
title: Banner
summary: The in-page banner for a fact that changes what you can do on this page, such as a restart that is needed, a usage pause or a missed alarm, with one action.
audience: builders
owner: app-design
status: draft
---

# Banner

A banner sits in the page flow, above the content it is about, and says one fact with at most
one action: changes waiting for a restart, teammates paused by usage, an alarm missed while the
box was down, the phone holding the keyboard in Glass. It is a quiet fill, never a colour. The
box not answering is the pill, not a banner. Drawn on the boards "Settings · account and project
scopes" (restart), "Project settings, Teammates and usage" (usage pause), "Planner, phone and
desktop" (missed alarm), "Glass · take-over and hand-back states" and "Vault, phone and desktop".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/views/planner.css` `.pl-banner` (main); `deck/chat/term.css` `.term-note` (main) | partial |
| App | `apps/app/src/ui/NotifyBar.tsx`, `apps/app/src/ui/SignInBar.tsx` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/AgentDeskView.swift` WaitingHint (work/capsule-pro) | partial |

## Anatomy

Flex row, align center, gap 12, min height 40, padding 8 12 8 16, radius 10, fill `--hover`. No
border, no shadow.

1. **Icon.** 16, `--text-2`: refresh (restart), pause (usage), clock (alarm), hand (Glass), lock
   or key (vault), info otherwise.
2. **Text.** A column, `min-width: 0`, grow: the fact in base size 600 `--text` ("2 changes apply
   after restart"), then an optional detail line in meta size `--text-2`, one line with ellipsis
   ("Lock after idle, Terminals open at once · your account · sessions reconnect in about 5 s").
3. **Action.** At most one, right: an outline button at 28 on the desktop ("Restart now",
   "Resume anyway"), 44 on the phone. A ghost "Dismiss" may follow a fact that needs no action.

## Variants

| Variant | Fact | Detail | Action |
|---|---|---|---|
| Restart needed | "2 changes apply after restart" | the setting names · scope · the cost | Restart now |
| Usage pause | "Teammates paused: plan at 85 percent until 16:00" | "Running work finishes." | Resume anyway |
| Resumed | "Resumed until the window resets at 16:00" | | Undo (4 s) |
| Missed alarm | "Missed while the box was down" | "Alarm · 06:30 · Early bake" | Done, Dismiss (ghost) |
| Glass keyboard | "Your phone has the keyboard · 2:14" | "kit is paused and this view is read-only." | none |
| Vault note | "12 passwords are reused" | "A todo is waiting in Planner" | none (the banner opens it) |
| One-time notice | the fact, in `--text-2` 12/16 | | none |

A firing alarm is not this banner: it rings on every device and is drawn by the agenda spec. "The
box can't be reached" is NOT this component - native-core already committed (CHAT.md, 30 Sep, C5)
to reading `link.health {reach, why, fix?}` straight into the existing floating pill
(`pill.md`), not a new banner; see that file's Unreachable states instead. Noted here only so a
future reader doesn't add a second, conflicting "unreachable" surface.

## Sizes

Width fills the content column. Phone: padding 10 14, radius 10, fact 13/18 600, action 44. It
never grows past two text lines; longer detail truncates.

## States

- **Shown** when the fact becomes true; it stays until the fact changes (restart done, window
  reset) or Dismiss.
- **Busy.** The action keeps its width with a spinner and a verb ("Restarting").
- **Updated.** When the count changes ("3 changes apply after restart") the text changes in
  place; the banner does not re-animate.
- **Done.** It collapses over `--motion-tap`; a short-lived result may take its place for 4 s
  ("Resumed until 16:00 · Undo").

## Keyboard and touch

The banner is not focusable; its action is a normal button in the tab order at its position in
the page. Never trap focus, never steal it on appear.

## Motion

Appear: height from 0 and opacity over `--motion-panel` (220), pushing the content down once.
Leave: the reverse over `--motion-tap`. Reserve its space when the fact is known at first paint,
so the page does not jump after load. Reduced motion: no height animation.

## Copy

Say the fact and its cost in plain words; the action is a verb naming what it does. Never
"Warning:", "Attention", "Heads up", caps labels or an exclamation mark.

## Accessibility

`role="status"` (polite) for facts that arrive while you are on the page; none for facts present
at load. The icon is `aria-hidden`; the fact text carries the meaning. No beacon, bone or red:
the fill is `--hover` and text passes AA on it.

## Gaps

Deck
- [ ] No shared banner: `.pl-banner` and `.term-note` each draw their own, and the planner's
      banner uses a beacon border; use `--hover` fill and no border.
- [ ] No restart banner on the Settings page (work/native-core).

App (work/mobile)
- [ ] NotifyBar and SignInBar are inline bars with their own styles; build one Banner with icon,
      fact, detail and one action.

Capsule (work/capsule-pro)
- [ ] WaitingHint is a 30 tall hint line; banners are not drawn in the Capsule panel.
