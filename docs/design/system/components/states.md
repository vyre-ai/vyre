---
title: States
summary: The seven patterns every list applies on every surface, empty, loading, offline, error, many items, long names and decided, each with its exact copy.
audience: builders
owner: app-design
status: draft
---

# States

Every list has the same seven states, on the phone and the desktop, and none leaves you without a
next step. These are patterns applied to list, needs-row, list-row and the pages, not a widget of
their own. Drawn on "States · every list, every size".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `.empty` and `.reach` in `deck/css/deck.css` (main); `deck/js/empty-actions.js`, the skeleton in `deck/js/now-phone.js` (work/pwa) | partial |
| App | `Empty` in `apps/app/src/ui/Screen.tsx` (work/mobile) | partial |
| Lumen | `OfflineBanner` in `local/capsule/native/Sources/UI/AgentDeskView.swift` (work/capsule-pro) | partial |

## Empty

- A short noun phrase and the first action, inline. No illustrations, no pictures, no mascot.
- Phone: phrase 17 `--text`, one line 13 `--text-2`. Desktop: phrase 15/600, line 13 `--text-2`,
  then the action (a field and a primary, or a primary and a ghost).
- Copy: "Nothing needs you" / "juno will put anything that needs you here."; "Nothing running" /
  "Start a chat below, or open a project."; "No projects yet" / "A project keeps threads, files
  and agents for one piece of work." with a Name field, Create (⏎) and Import a folder (ghost).
- Needs you empty is calm: no dot, no badge, the mark's dot back to `--mark-dot`. Empty never
  hides the page's other sections.

## Loading

- Skeleton rows shaped like the rows they replace and at their height (tile, title, one line,
  meta): bars `--hover`, radius 4, 10 tall. Shine: a `--hover` to `--rule` gradient, 1.4 s
  linear, off under reduced motion.
- No spinner wall: one 14 px spinner in the header.
- At 10 s one line appears under the skeleton: spinner, "The box is slow to answer" (13
  `--text-2`), Cancel (ghost). Cancel keeps whatever arrived.
- Cached content paints first (Needs you under 1 s from cache); skeletons show only for what has
  no cache.

## Offline and reconnecting

- Content stays on screen. One pill, top centre, never a wall: 28 tall, radius 14, `--panel`, 1 px
  `--rule-strong`, `--float`, 12 `--text-2`.
- After 2 s: spinner and "Reconnecting…". After 60 s: "No answer from the box since 14:02 · Retry
  now" ("Retry now" at 600, a button). Phone, where space is short: "No answer since 14:02 · Retry
  now".
- The header status reads "offline" with a `--label` dot.
- Outbox line under a queued message, 12 `--label` with the clock icon: "Queued · sends when the
  box is back"; below it "Outbox 1 · this thread was saved on this phone at 14:02".
- An approval tapped offline: "Will send when online" and "Touch ID confirmed 12 min ago. If it
  lapses first, you confirm once more." with Undo.
- Needs you and the Vault need the box and are never cached: "Needs you needs the box." / "Last
  checked 14:02."; "The vault opens only when the box answers" / "Passwords, keys and codes are
  never saved on this Mac. Nothing here is cached, so nothing here can go stale or leak." /
  "Last opened 13:48 · Touch ID".
- Cached for 7 days: projects, agents, the last 20 threads.

## Error

- Plain words, then the detail in mono, then a way out. The crossed-circle glyph in `--text`; no
  red, no tint, no violet.
- Title 17/600 (phone) or 15/600 (desktop): "Couldn’t load kit’s history". Detail in a `code`
  block (`--code-bg`, radius 8, mono 13): "ECONNRESET after 15 s". One line 13 `--text-2`: "The
  box answered, then dropped the stream. Your threads are safe."
- Actions: Retry (primary, key R on desktop) and Open doctor (outline). Meta 12 `--label`:
  "Failed 14:31 · 3 tries". In a list the row's status reads "failed · history" with the glyph.

## Many items

- The exact count in the header ("128 · oldest first"). Badges cap at "99+" on the rail and in
  "Needs you 99+".
- Filter chips with their own counts: "All 128", "Asks 71", "Drafts 40" (chip-on: 1 px `--focus`,
  `--signal-wash`).
- Group headers (32 tall, 12/600 `--label`, the count after) stick while the list scrolls, on a
  `--bg` (or `--panel` in a card) fill so rows pass under them.
- 40 rows at a time: "Load 40 more" (secondary 28) and "Showing 40 of 128" 12 `--label`, so J and
  K stay predictable. Virtualize over 100 rendered rows.

## Long names

- Desktop: one line with an ellipsis; the full name in the `title` attribute and in the detail
  header. Titles never wrap on desktop.
- Phone at larger text sizes: titles wrap to two lines and the row grows; never clipped
  mid-glyph. At default size they truncate to one line.
- Paths truncate like names, in mono, and the detail keeps the file name visible (truncate the
  folders, not the file).

## Decided

- Once answered, the violet dot and label leave. The tile shows a neutral glyph (check, cross,
  clock) in `--text-2`; the title drops to 400.
- Copy: "Allowed once by you · 14:22", "Denied by you · 14:25", "Expired after 24 h" with "Ask
  again" (ghost). The header says "Nothing needs you".
- Decided rows stay for the day under "Decided today", then live in the session's history.

## Keyboard and touch

Retry is R, Load 40 more is reachable by Tab after the last row, Esc cancels a slow load. Phone
targets stay 44 minimum in every state.

## Motion

Skeletons swap for rows in place; no fade needed. The pill fades in over `--motion-reveal`. A
decided row collapses on the frame the answer commits. Reduced motion: no shine, no fades.

## Accessibility

- Skeletons are `aria-hidden`; the list has `aria-busy="true"` while loading.
- The pill is `role="status"`; errors are `role="alert"` once.
- Counts over 99 read the exact number to screen readers ("128 need you").

## Gaps

Deck (main, work/pwa)
- [ ] No skeleton outside the phone Now card; loading is text.
- [ ] Offline is a full-width line (`.reach`), not the pill; no 2 s and 60 s stages.
- [ ] Long lists use "Show earlier", not "Load 40 more" with a count; no sticky group headers.
- [ ] Failed marks are violet in places (status marks); spec is the neutral crossed circle.

App (work/mobile)
- [ ] `Empty` only: no skeleton, no offline pill (`useConnection` is unused), no decided state.

Lumen (work/capsule-pro)
- [ ] Offline banner reads "OFFLINE" in caps; no queued count; no skeleton.
