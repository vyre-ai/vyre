---
title: Needs row
summary: The one row for everything that waits on you, of every kind, with a title, one detail line and a kind line, answered by a swipe on the phone and by keys on the desktop.
audience: builders
owner: app-design
status: draft
---

# Needs row

The one-row primitive of Needs you: every kind that waits on you draws as this row, on Now on
every surface and in the Capsule's list. The rows and the one count come from `waiting.list` and
`waiting.count` (see One list and one count, below). Drawn on the boards
"Needs you, phone and desktop", "Needs you, teammate kinds", "States, every list, every size"
(decided, many items) and "Devices, trusting a browser for the vault" (device trust).

| Surface | Implementing file | Status |
|---|---|---|
| Deck, phone | `deck/js/need-rows.js`, `deck/js/now-phone.js`, `deck/css/views/now.css` (work/pwa) | built |
| Deck, desktop | `deck/views/now.js`, `deck/css/views/now.css` (main) | partial |
| App | `apps/app/app/(tabs)/index.tsx` NeedRow, `src/ui/Row.tsx`, `src/ui/SwipeRow.native.tsx`, `src/ui/SwipeRow.web.tsx` (work/mobile) | partial |
| Capsule | `local/capsule/native/Sources/UI/AgentDeskView.swift` WaitingRow, WaitingList (work/capsule-pro) | partial |

## Anatomy

1. **Tile.** Agent tile, 32 square, radius 8, fill `--hover`, the agent's initial at 13/600
   `--text`. Kinds with no agent put a 16 icon in the tile in `--text-2`: reminder (calendar),
   usage pause (pause bars), device trust (phone or globe).
2. **Title line.** Verb and object ("Send email to Sam", "Push q3-report", "kit has a question",
   "design is stuck"), 600, one line, ellipsis. Age right, meta size `--label`: "now", "12m",
   "3h", "2d"; a reminder shows its time ("15:00").
3. **Detail line.** One line, `--text-2`: the command in mono for an ask
   (`git push origin q3-report`), the subject for a draft, the question, the host for a grant,
   the reason for merge failed, stuck and usage.
4. **Kind line.** Meta size `--label`: "Ask · kit · Harlow Legal", "Reminder · you added it". A
   teammate's ask adds a fourth line in the same style: "asked by Q3 report".

Kinds (the kind line's first word): Ask, Draft, Question, Sign-in grant, Reminder, Plan, New
teammate, Merge failed, Stuck, Usage, Device, Pairing. Oldest first, always. The group header carries the
beacon dot and "Needs you" in `--beacon-ink` (see the list spec); the row itself is never tinted,
bordered or washed in violet.

## Sizes

| | Desktop (list pane) | Phone (Now card) |
|---|---|---|
| Padding, tile gap, line gap | 10 by 16, 10, 2 | 12 by 14, 12, 2 |
| Title | 13/18, 600 | 17/24, 600 |
| Detail | 13/18 (mono 13) | 13/18 (mono 13) |
| Kind line, age | 12/16 | 12/16 |
| Height (3 lines) | 76 | 86 |

Fixed height per line count, so a virtualized list never measures; at larger phone text sizes
the title wraps to two lines and the row grows. Desktop rows sit on `--bg` with a `--rule` bottom
border; phone rows sit in a card (`--panel`, `--rule`, radius 10) with `--rule` between rows.

## States

- **Hover** (desktop) and **pressed** (phone, no transition): fill `--hover`. **Focus:** 2 px
  `--focus` outline, offset -2.
- **Selected** (desktop). Fill `--signal-wash`; kind line and age step up to `--text-2`. The
  detail pane answers the selected row.
- **Swiping** (phone). The row slides over the reveal: right shows the primary on `--primary-bg`
  with `--primary-ink` label and 20 icon (check); left shows the second action on `--hover` in
  `--text`. Each reveal is 100 wide. When the primary needs presence and no proof covers it, the
  reveal shows the Face ID glyph (Touch ID on a Mac, fingerprint on Android) beside its label.
- **Committed.** On the frame the swipe commits, the row's height goes to 0 over `--motion-tap`
  and the undo toast shows (see the toast spec). The answer waits `--motion-undo` (4 s) in the
  outbox, then sends. Undo cancels it and the row comes back in its place.
- **Refused.** The row returns; the kind line reads the reason in `--text` with the failed mark.
- **Decided.** Neutral: the tile shows a 16 glyph in `--text-2` (check, x, clock), the title drops
  to 400, the detail line reads who decided and when, and the kind line goes. Rows stay under a
  "Decided today" group for the day, then live in the session's history.
- **Offline.** Never cached: "Needs you needs the box." and "Last checked 14:02."

## Keyboard and touch

Phone swipe, by kind (right commits the primary; left is the second action with Undo 4 s):

| Kind | Right | Left |
|---|---|---|
| Ask | Approve | Deny |
| Draft | Send (Face ID glyph unless covered) | Discard |
| Sign-in grant | Allow (Face ID glyph unless covered) | Deny |
| Question | Answer (opens the sheet: an answer needs a choice) | Later (hidden here 1 h) |
| New teammate | Approve | Not now |
| Stuck | Retry | Cancel |
| Usage | Resume anyway | none |
| Device | Trust (Face ID glyph, always) | Not now |
| Reminder | Done | Snooze 5 min |
| Pairing | Pair (opens the code field: a pairing needs its code) | Not now |
| Plan, Merge failed | open the sheet | none |

The swipe is a scroll-snap strip on the compositor (native: the UI thread). Release commits at
a full 100 reveal or a 0.5 px/ms fling past 24; 40 to 100 rests open; under 40 closes. Tap opens
the detail sheet with Open session. Asks and questions never need a proof.

Desktop, on the focused list: J and K move, A allows (the primary of any kind), D denies or
discards, ⌘⏎ sends a draft, F asks a teammate to fix a failed merge. The selection moves to the
next row after an answer. Footer: "J K move · A allow · D deny · ⌘⏎ send" with key-hint chips.

Capsule: the query field holds focus, so ↑ and ↓ move, ⏎ opens the card, A allows.

## One list and one count: waiting

Every surface draws Needs you from cohesion's `waiting` module (ADR 0036 decision 4), and from
nothing else. No surface merges asks, held drafts, reminders and pairings on its own, and none
keeps its own count.

**Rows.** `waiting.list {limit?}` returns `{rows, count, by_kind, partial?}`. Each row maps onto
this row as follows:

| Field | Draws as |
|---|---|
| `id` | the row's key: the undo, the outbox, push and every device resolve by it |
| `kind` | the kind line's first word and the tile: `ask` is Ask (Question when `answer.fill` names `answers`), `draft` is Draft, `reminder` is Reminder (calendar icon), `pairing` is Pairing (laptop icon) |
| `title` | the title line, as given ("Send email to Sam", "Pair the Mac "alex's MacBook Air"") |
| `detail` | the detail line; mono only when it is a command or a path |
| `project`, `thread` | the kind line after the kind ("Ask · kit · Harlow Legal"); tap or ⏎ opens the thread |
| `at` | the age on the title line; the surface sorts oldest first by `at` (the tool answers newest first) |
| `source` | not shown; it names the owner for errors ("Couldn't reach the planner") |
| `answer` | what the primary and the second action call (below) |

**Answering.** The row's primary calls `answer.tool` with `answer.input` and what the person gave
for each name in `answer.fill`: nothing more for `[]` (a draft's Send, a reminder's Done), the
choice for `decision` (Approve, Deny), the chosen answers for `answers` (the question card), the
code for `code` (a pairing). The owner does the work (`threads.answer`, `gate.approve`,
`planner.done`, `link.pair.approve`); the surface never calls anything else. When the answer lands,
`waiting.changed` fires and the row leaves on every device at once.

**The count.** One number everywhere, `waiting.count {}` (`{count, by_kind}`), kept fresh by
`waiting.changed {count, by_kind}`, never by counting rows on the screen:

| Where | How it shows |
|---|---|
| Deck rail, Now | the 18 badge (rail.md, status-mark.md) |
| Deck top bar, any page but Now | the needs count (top-bar.md) |
| Phone, the Now page label and the app icon | the 18 badge; the app icon's badge number |
| Capsule | the group header "Needs you · 3" and the menu-bar mark's dot |
| Menu bar | the mark's violet dot while the count is above 0 |
| Status line and CLI | "3 need you" (`vyre needs`) <!-- terms: ignore --> |
| Favicon | the badge |

When `partial` names a source, the count shows what was read and the list ends with one row in
`--label`: "Couldn't reach the planner · Retry". Kinds that waiting does not merge yet (Sign-in
grant, New teammate, Merge failed, Stuck, Usage, Device, Plan) stay where they are today and are
not counted by a surface on its own; each is a gap for cohesion below.

**Pairing.** A Mac asks to join. Tile: the laptop icon. Title "Pair the Mac "alex's MacBook Air"";
detail the node and login (`alex-mba · alex`); kind line "Pairing · expires in 8 min" (the link
TTL). The primary is **Pair**; it opens the code field in place of the detail line (desktop, the
detail pane; phone, the sheet): a field, mono 13 (17 on the phone), 6 characters, "Enter the code
shown on the Mac", then Pair (primary) with the Touch ID glyph (Face ID on the phone), since pairing
always needs a proof. A wrong code reads "That code doesn't match. 2 tries left." in the help line.
Not now leaves it until it expires. Decided: "Paired by you · 14:22" or "Expired after 10 min".

## Motion

Collapse over `--motion-tap` with `--ease`; the reveal tracks the finger; a release that does not
commit springs back over `--motion-panel`. Reduced motion: no height animation.

## Copy

- Decided: "Allowed once by you · 14:22", "Denied by you · 14:25", "Sent by you · 14:30",
  "Expired after 24 h" with a ghost "Ask again".
- Hint under the phone card until the first swipe: "Swipe right to approve, left to deny."
- Never "Are you sure", "Waiting on you" or caps.

## Accessibility

One button labelled with the whole row: "kit, Harlow Legal, wants to push q3-report, git push
origin q3-report, 4 minutes ago. Actions: Approve, Deny, Open." Swipe actions are accessibility
actions (native) and real buttons shown while the row has focus (web). The group label says
"Needs you", so status is never colour alone; meta on `--signal-wash` steps up to `--text-2`.

## Gaps

Deck, phone (work/pwa)
- [ ] Kind line omits the kind (`thirdLine` is "agent · project"); no "asked by", no decided
      state; kinds limited to ask, draft, question, pair.
- [ ] An approve goes at once with no Undo; a draft's right swipe opens the sheet instead of
      committing Send with the Face ID glyph.
- [ ] Swipe is pointer events in JavaScript, not a scroll-snap strip.
- [ ] Title 16/21, detail 15/20, age 13; the tile has a `--rule-strong` border.

Deck, desktop (main)
- [ ] A card per item with inline actions, not list and detail; no J, K, A, D keys.
- [ ] Time and error text in `--beacon-ink`, rules in `--beacon-rule`, gold `--recall-ink`: remove.

App (work/mobile)
- [ ] Kind line is "agent · project"; only gate and ask kinds; no decided state.
- [ ] Commit at 40% of the row width, not 100 or a fling; reveal has no icon or Face ID glyph.
- [ ] Rows sit on `--bg` full width, not in a `--panel` card.

Adopting waiting.list, every surface
- [ ] Deck, phone and desktop (work/pwa): `deck/js/needs.js` merges its own sources; draw from
      `waiting.list`, count from `waiting.count` and `waiting.changed`, answer through
      `answer.tool`; add the Pairing row.
- [ ] App (work/mobile): read `waiting.list` and `waiting.count`; the Now label badge and the app
      icon badge from the one count; the Pairing row with its code field.
- [ ] Capsule (work/capsule-pro): the list and the "Needs you · n" header from `waiting.list`; the
      menu-bar dot from `waiting.changed`; answer through `answer.tool`.
- [ ] CLI and status line (work/polish-cli): `vyre needs` and the status line count from <!-- terms: ignore -->
      `waiting.count`.
- [ ] Push (work/pwa): resolve by row `id`, so one answer clears every device.
- [ ] cohesion: merge the kinds waiting does not have yet (Sign-in grant, New teammate, Merge
      failed, Stuck, Usage, Device, Plan), each from its owner's tool.

Capsule (work/capsule-pro)
- [ ] Two lines, no kind line, a 7 dot for the tile, 40 tall; header "WAITING ON YOU" in caps.
- [ ] Selected row has a 2 px violet left bar (violet as a border): use the `--hover` fill only.
