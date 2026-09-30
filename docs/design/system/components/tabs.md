---
title: Tabs
summary: Segmented tabs that switch views inside a detail pane (Session, Terminal, Files; Now, Inbox, Results, Notes, Setup), and the phone's tab strip.
audience: builders
owner: app-design
status: draft
---

# Tabs

Tabs switch between views of the same thing inside a detail pane: a session's Session, Terminal
and Files; a teammate's Now, Inbox, Results, Notes and Setup; an agent's Watch and Files. They are
not navigation between places (that is the rail and the phone pages). Drawn on "Session, phone
and desktop", "Plan approval and modes, phone and desktop", "Agents place, teammates" and "Agents and their
computers".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/css/deck.css` `.seg`, `deck/glass/index.js` `.gl-tabs` (main); `deck/css/views/memory.css` `.mem-tab` | partial |
| App | none (work/mobile) | not built |
| Capsule | not used (the Mac Capsule has no detail pane) | not used |

## Anatomy

**Segmented tabs** (desktop, and the phone with three or fewer tabs). The segmented control's
shape with tab semantics: container fill `--hover`, padding 2, gap 2, radius 8; tabs height 28,
padding 0 12, radius 6, base 13/18, `--text-2`. Selected: fill `--panel`, ink `--text`, weight
600, 1 px `--rule-strong` ring. Left aligned under the detail header, never full width on desktop.

**Tab strip** (phone, four or more tabs). A row 44 tall under the header, padding 0 16, gap 18,
bottom border 1 px `--rule`, scrolls sideways. Tabs base 13/18 `--text-2`; selected `--text`
weight 600 with a 2 px `--text` underline at the bottom edge.

Each tab: label, then an optional count as plain text ("Inbox 3"), or a status mark before the
label when something under it needs you (the 8 `--beacon-dot`) or is running (the ring).

## Variants

| Set | Tabs | Where |
|---|---|---|
| Session | Session, Terminal, Files | Session detail, desktop and phone |
| Teammate | Now, Inbox, Results, Notes, Setup | Teammate detail (Agents place) |
| Agent computer | Watch, Files | Agent detail with a computer |
| Usage | Roster, Limits, Budget | Project settings |

## Sizes

| | Desktop | Phone |
|---|---|---|
| Segmented | 28 tabs, 32 overall | full width, tabs share it equally, 40 tabs, 44 overall |
| Strip | not used | 44 row |

## States

- **Default.** Ink `--text-2`.
- **Hover** (pointer). Ink `--text`.
- **Selected.** As above; exactly one.
- **Focus.** 2 px outline `--focus`, offset 2 (inside the strip: offset -2).
- **Needs you.** The beacon dot before the label, even when not selected.
- **Disabled** (a view not available, e.g. Terminal with no pty). Ink `--label`, not focusable;
  the pane says why if chosen from a link.
- **Loading.** The tab switches at once; the pane shows its skeleton rows, never a spinner over
  the tabs.

## Keyboard and touch

- Tab moves into the tablist, landing on the selected tab. ← → move and select (automatic
  activation); Home and End jump to the ends.
- Phone: tap. No swipe between tabs; horizontal swipes belong to the phone's pages. The key bar
  shows only in Terminal.
- The selected tab is remembered per item and restored when the item reopens.

## Motion

The selected fill moves instantly; the pane content swaps with no slide. The strip scrolls the
selected tab into view over `--motion-panel`. Reduced motion: instant.

## Copy

One or two words, sentence case, nouns: "Session", "Terminal", "Files", "Inbox 3". Counts are
plain numbers after the word. Never icons alone, never caps.

## Accessibility

- `role="tablist"` with `aria-label` ("Session views"); tabs `role="tab"` with `aria-selected` and
  `aria-controls`; panes `role="tabpanel"`.
- The count and mark join the name: "Inbox, 3", "Setup, needs you".
- Selected `--text` on `--panel` and default `--text-2` on `--hover` pass AA in both themes.

## Gaps

- [ ] Deck: no Session, Terminal, Files tabs or teammate tabs; `.seg` is used with
  `aria-pressed` or `role="group"` in places and `role="tablist"` only in Glass.
- [ ] Deck: `.seg` draws a `--rule` border, 26 tabs and `--hover` for the selected fill; use the
  `--hover` container and the `--panel` selected tab.
- [ ] Deck: `.mem-tab` in Memory is a third tab style (34 tall, text only); fold into these two.
- [ ] App: no tabs; build `Tabs` with the segmented and strip forms.
- [ ] System: the teammate phone strip is drawn 40 tall; this spec makes it 44.
