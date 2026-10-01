---
title: Suggestions
summary: The one suggestion list for Lumen input, the chat composer on the Deck, the PWA and the app, and later the CLI, drawn from suggest.query. One row look per kind, the three lanes, inline phrase completion as ghost text, and rows that never jump.
audience: builders
owner: app-design
status: draft
---

# Suggestions

What you are typing toward, offered as you type: an agent after @, a command after /, an account,
a name from memory or an upcoming item on the last word, and the rest of a phrase as ghost text.
Every surface asks the same tool, `suggest.query {text, cursor, surface}` (cohesion, ADR 0036
decision 3), and draws the answer with this one list. It replaces the composer's own @ and /
lists and Lumen's own @ ranking; it reuses the popover (completion variant), the list row,
the avatar and the key hint, and adds no new part. Not drawn on a board yet (see Gaps).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | the chat-core composer: `deck/chat/pickers.js`, `deck/chat/composer.js` (work/chat; the composer is shared with native-core) | partial |
| App | the chat-core composer in `apps/app/src/session/Composer.tsx` (work/mobile) | not built |
| Lumen | `local/capsule/native/Sources/UI/CapsuleView.swift` results and the @ target (work/capsule-pro) | partial |
| CLI | the prompt of `vyre open` and the Capsule-in-terminal (work/polish-cli), later | not built |

## Anatomy

The answer is `{items: [{kind, sub?, label, insert, detail?, action?, source, id, score}], late?}`.
Each item draws as one list row (list-row.md), dense on the desktop and 44 on the phone:

1. **Leading.** The kind's icon or avatar, 16 in `--text-2`, or a 24 tile (20 in Lumen).
2. **Label.** Base size `--text`, one line, ellipsis. The part that matched the typed text is 600,
   the rest 400. Commands, files and paths in JetBrains Mono 13.
3. **Detail.** Meta 12/16 `--label`, one line, after the label on the same row (dense) or under it
   (phone, two line).
4. **Trailing hint.** Meta 12/16 `--label`: the kind's word, a marker or a key hint chip.

One row look per kind:

| Kind | Sub | Leading | Label | Detail | Trailing |
|---|---|---|---|---|---|
| mention | agent | agent tile, initial ("k") | kit | "your assistant", or what it is doing ("drafting the q3 report") | Agent |
| mention | project | tile with the projects icon | Harlow Legal | "Harlow Legal · 12 threads" | Project |
| mention | thread | chat icon | Estate planning intake | "Harlow Legal · working" | Thread |
| mention | person | person avatar (circle), initial | Dana | "Harlow Legal, Northwind Bakery" | Person |
| command | | terminal icon | `/compact` (mono) | what it does ("Summarise and free up context") | the key hint when it has one, else nothing |
| account | | the provider tile (account-row.md) | alex@harlowlegal.com | "Harlow Legal · Google" | Default, Last used, or its state (account-row.md) |
| entity | | memory icon | Northwind Bakery | "From memory · a client of yours" | Memory |
| file | | file icon | `src/intake/estate.ts` (mono) | "edited 2m" | nothing |
| time | | alarm icon (planner icon for an event) | Call with Dana | "in 2 h · event" | Planner |
| phrase | | never a row: see Ghost text | | | |

The kind word on the right is sentence case and never a chip. A row whose item has `action` runs
that action on ⏎ instead of inserting (a time row opens the item; an account row starts from that
account); every other row replaces the token at the cursor with `insert`.

**Ghost text.** The top `phrase` item, when its `insert` begins with the typed word, draws the rest
of the phrase after the caret in `--label`, same size and font as the input, never underlined or
boxed. It shows only with the caret at the end of the text, and only when no list row is active.
At most one phrase shows. Phrases never draw as rows.

**Group headers.** 12/16 600 `--label`, 24 tall, sentence case, only when two or more groups show.

## Variants

**Lanes.** The token at the cursor decides the lane, on the box, the same on every surface:

| Token | Lane | Kinds asked | Group order |
|---|---|---|---|
| `@x` anywhere | Mentions | mention (chat adds file) | Agents, Projects, Threads, People, then Files in chat |
| `/x` at the start of the input | Commands | command | Built in, the project, Plugins and skills (as composer.md) |
| any other last word, 2 characters or more | Words | account, entity, time, file, phrase | Accounts, From memory, Upcoming, Files; the phrase as ghost text |

Inside a group, rows keep the box's `score` order. The surface never re-sorts, re-ranks or adds
rows of its own.

The Words lane is quiet: it opens the list only when a row is a whole-word or prefix match, and it
shows at most 3 rows; otherwise it shows only the ghost text, or nothing. The Mentions and Commands
lanes open on the first character after @ or /.

**Placement.**

| Surface | Where | Max rows |
|---|---|---|
| Chat composer, desktop (Deck, PWA on a laptop) | a popover (completion variant) above the composer box, anchored to its left edge, the composer's width minus 40 | 8 at 28 (dense), then the list scrolls inside |
| Chat composer, phone (PWA, app) | the same popover above the keyboard, full width minus 16 | 4 at 44 |
| Lumen | no popover: the rows are Lumen's result rows (44), in its own groups; mentions go under Agents, Projects and Sessions, commands under Commands, accounts under a "Send from" or "Accounts" group | the body's height |
| CLI (later) | printed under the prompt line, one row per line, mono 12 | 6 |

In Lumen the Mac's local index rows paint first (under 50 ms, capsule.md) and rows from
`suggest.query` fill in below them in the same groups; a row that is in both draws once, in the
local slot.

## Sizes

| | Desktop popover | Phone popover | Lumen |
|---|---|---|---|
| Row | 28 (commands), 30 (files), 32 with a tile | 44, 56 with a detail line | 44 |
| Leading | 16 icon, 24 tile | 16 icon, 32 tile | 16 icon, 20 tile |
| Label | 13/18 | 17/24 | 13/18 |
| Detail, trailing | 12/16 | 12/16 | 12/16 |

## States

- **Active row.** The first row is active when the list opens. Fill `--signal-wash`; detail and
  trailing step up to `--text-2`. When a new answer arrives, the active row stays active by `id`
  if it is still there, else the first row is.
- **Answer arriving.** Each keystroke asks once; an answer for an older keystroke is dropped by
  sequence. The list draws what came back and never waits.
- **Late sources.** `late` names sources that missed the 25 ms deadline. The surface never waits
  for them and never shows a spinner for them. Their rows come with the next keystroke. Rows that
  are drawn never move because of a late source: late rows may only be added below the rows
  already drawn.
- **Nothing.** In the Mentions and Commands lanes, one row in `--label`: "No agents or projects
  match @sa", "No commands match /xyz". In the Words lane, nothing at all.
- **Accepted.** The token is replaced, the list closes, and the surface calls
  `suggest.picked {kind, source, id}`. Ghost text accepted sends `suggest.picked` for its phrase.
  Closing the list or typing past it sends nothing.
- **Offline.** Lumen keeps its local rows; chat shows no list and no error.

## Keyboard and touch

| Key | With the list open | With ghost text and no list |
|---|---|---|
| ↑ ↓ | move the active row | recall, as composer.md |
| Tab | accept the active row | accept the ghost text |
| → | moves the caret, closes nothing | at the end of the text, accept the ghost text |
| ⏎ | accept the active row (it does not send) | send, as the composer does |
| Esc | close the list; the next Esc is the composer's | clear the ghost text; the next Esc is the composer's |

Focus stays in the input the whole time (`aria-activedescendant`). On touch, tap a row to accept
it; tap the ghost text, or the "Tab" key on an iPad keyboard, to accept it. Rows are 44 on the
phone.

## Motion

The popover opens as popover.md (opacity over `--motion-tap`). Rows change in place with no
animation, and nothing slides or fades as you type. Ghost text appears and goes in the same frame.

## Copy

- Group headers: Agents, Projects, Threads, People, Commands, Built in, Accounts, Send from, From
  memory, Upcoming, Files.
- Trailing words: Agent, Project, Thread, Person, Memory, Planner, Default, Last used.
- Empty rows: "No agents or projects match @sa", "No commands match /xyz".
- Never "Suggested", "AI", "Smart", "Did you mean", or a sparkle icon.

## Accessibility

- The input is a `combobox` with `aria-autocomplete="both"`; the list is a `listbox` of `option`
  rows with `aria-selected`, each group a labelled `group`.
- Each option's name is the label, the kind word and the detail: "kit, agent, your assistant".
- Ghost text is `aria-hidden`; the input's description says "Tab to complete: <phrase>" and is not
  a live region, so typing is never interrupted.
- The active row's wash and meta pass 4.5:1 (meta steps up to `--text-2` on the wash).

## Gaps

Deck, chat composer (work/chat, shared with native-core)
- [ ] The / and @ pickers read their own command and file lists; call `suggest.query` per
      keystroke and draw its lanes and groups.
- [ ] No agents, projects, threads or people after @; no Words lane; no ghost text.
- [ ] No `suggest.picked` on accept.

App (work/mobile)
- [ ] Nothing built: the composer is text only; take the chat-core list with 44 rows, 4 at most.

Lumen (work/capsule-pro)
- [ ] The @ target ranks its own agents and sessions; draw `suggest.query` rows under the local
      rows, in Lumen's groups, never moving a drawn row.
- [ ] No ghost text in the input; no `suggest.picked`.

cohesion
- [ ] The @ lane in chat asks file sources too (the composer's file list as an offered source).

memory-iq
- [ ] Offer the entity source (people, places and aliases from memory already loaded) with
      `suggest.offer`, never a model call.

CLI (work/polish-cli)
- [ ] Later: the same lanes and order under the prompt; Tab accepts.

System (app-design)
- [ ] The Suggestions board on the canvas: the three lanes, ghost text, Lumen groups.
