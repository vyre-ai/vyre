---
title: Tip
summary: One quiet tip at a time on every surface, from tips.next. A muted line or chip with its key or command, Show me, a close and "Hide tips about this"; plus the one "What's new" card after an update.
audience: builders
owner: app-design
status: draft
---

# Tip

A tip is one short line that teaches the next useful thing, in the place the person is working. It
is the quietest thing on screen: muted text, never the attention colour, never taking focus, gone
the moment anything else needs the person. The words come from modules' `teaches.tips` through
`tips.next` (docs team, `core/tips`, docs/build/tips.md); this page is how every surface shows one.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | the view's footer chip, `deck/js/tips.js` (proposed, work/pwa); chat's composer hint line (work/chat) | not built |
| App | the Places sheet line and empty screens (work/mobile) | not built |
| Capsule | the line under the empty input (work/capsule-pro) | not built |
| CLI | the dim "tip:" line on stderr (work/docs, `vyre tips`) | built <!-- terms: ignore --> |

## Anatomy

**Tip line** (the Capsule, chat's composer hint, the phone). One line, min height 28, gap 8,
12/16 `--label`:

1. A 12 lightbulb icon in `--label` (the icon set's `tip`).
2. The text. Backticked parts render as their kind: a `key` as a key hint chip (key-hint.md), a
   `command` in JetBrains Mono 12 `--text-2`. Any other backticked text is mono too.
3. **Show me** when the tip has `docs` or `command`: a ghost button, xs (28), 12/16 600 `--text-2`.
   With a command it copies the command ("Copied" for 2 s, in place); with docs it opens the page.
4. A close ×, icon button xs, `--label`, labelled "Dismiss tip".

"Hide tips about this" sits in the close's menu (a long press on the phone, a right click or the
tip's ⋯ on desktop), never as a visible third control. It dismisses every tip from that module.

**Tip chip** (the Deck and chat views). The same parts in a chip: height 28, padding 0 4 0 10,
radius 14, fill none, 1 px `--rule`, 12/16 `--label`, max width 560, the text truncating with an
ellipsis (the full tip is its tooltip and its accessible name). It sits at the bottom left of the
view's content column, 16 above the view's bottom edge (or above the composer in chat), in flow,
never floating over content.

**New mark.** A tip with `whatsnew` starts with "New" 12/16 600 `--text-2` and a middle dot in
`--label`. Never lime, violet or a filled badge.

**What's new card** (the Deck's Now, once after an update, on `tips.updated`). A card (card.md) at
the top of Now, above the Needs rows: "What's new in 0.2" 15/600 `--text`, then up to three tip
lines from that release, then "See all changes" (ghost, opens the release notes) and a close ×.
One tap on × removes it for good. It never shows while `waiting.count` is above 0; it waits.

## Placements

| Surface | Where | Only when |
|---|---|---|
| Capsule | a tip line under the empty input, in the body, padding 0 16, `--label` | the field is empty and nothing waits |
| Deck | a tip chip at the bottom left of the view; inside an empty state, the line under `.empty-actions` | the view is idle |
| Chat | the composer's hint line (under the composer, where the key hints sit) | the composer is empty |
| Phone | a tip line at the bottom of the Places sheet, and on empty screens under the empty state | the sheet or screen is idle |
| Glass | none during a take-over; the frame never carries a tip | never |
| CLI | a dim "tip:" line on stderr after the output (docs team) | the command succeeded |
| Status line | none by default; the CLI's `tip:` rule applies if the person turns it on | idle |

## States

| State | What shows |
|---|---|
| None to show | nothing. No empty slot, no reserved height |
| Shown | the line or chip; the surface calls `tips.seen {id, surface}` when it draws it |
| Busy (an ask, a draft, a running turn, typing) | hidden at once, in the same frame; `tips.next {busy: true}` answers none |
| Something waits (`waiting.count > 0`) | hidden; the waiting row owns the attention |
| Show me pressed | the action runs; `tips.seen {acted: true}`; the tip leaves |
| Closed | the tip leaves on that frame; no toast, no undo |
| Hide tips about this | the tip leaves and a toast (toast.md) says "No more tips about planner · Undo" for 4 s |

A tip never sits over a question, an approval, a plan or the waiting list, and never moves them.

## Keyboard and touch

- A tip is never in the tab order by default and never takes focus. Its buttons are reachable by
  Tab only after the person moves focus into the footer region (F6 on the Deck).
- The Capsule: ⌘. dismisses the tip under the input; Show me has no key.
- Touch targets 44 on the phone (the drawing stays 28).

## Motion

In: opacity over `--motion-reveal` (150), after the view has settled (never during a load or a
stream). Out: opacity over 150. Nothing slides; nothing pulses.

## Copy

Tip words belong to the docs team and the modules (docs/build/tips.md). The surface's own words:
"Show me", "Copied", "Dismiss tip", "Hide tips about this", "No more tips about planner · Undo",
"New", "What's new in 0.2", "See all changes". Never "Pro tip", "Did you know?", "Hint", or an
exclamation mark.

## Accessibility

- The line or chip is plain text with `role="note"`, not a live region: a tip is never announced.
- Its accessible name is the full tip text with the key named in words ("Press Option Return to
  talk").
- Text 4.5:1 on its ground (`--label` on `--bg` and `--panel` in both themes passes; check the
  chip on `--hover` grounds).

## Gaps

Deck (work/pwa, work/chat)
- [ ] Nothing built: the footer chip, the empty state line, chat's composer hint line, the What's
      new card on `tips.updated`.

App (work/mobile)
- [ ] Nothing built: the Places sheet line and empty screen lines.

Capsule (work/capsule-pro)
- [ ] Nothing built: the line under the empty input, ⌘. to dismiss.

System (app-design)
- [ ] The `tip` (lightbulb) icon in icons.txt; the TipLine board on the canvas.
