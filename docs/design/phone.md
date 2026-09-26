# Vyre phone

The design for Vyre on a phone: the PWA first, then the native iOS and Android apps. Both build
from this file. Colours and type come from [TOKENS.md](TOKENS.md) and are pasted verbatim; this
file adds only phone roles, sizes and behaviour. Desktop (the Deck) shares the same tokens and
chat items, so a card looks the same on both.

Decision (2026-09-27): Direction B, "Instrument", with one change. On Now, "Needs you" is a
grouped list of rows (from Direction A), not a one-card-at-a-time stack. Every row swipes to
approve or deny, and every row opens a detail sheet.

## 1. What the phone is for

In order of how often it happens:

1. Glance at what needs you, and answer it (approve with Face ID, deny, reply, pick a choice).
2. Chat with a session or an agent, and read what it did.
3. Find anything: a session, a file, a memory, a command to run.
4. Watch an agent work.

Everything else (setup, rules, vault, connections) lives in Settings, behind the avatar.

Principles:

- What needs you comes first on every screen, and it is always one tap from an answer.
- Calm. One primary action per view, and no motion that is not feedback.
- Native gestures and sheets. Nothing the user has to learn twice.
- Light (SPEC principle 8). Nothing polls faster than 60 s, and live output streams only while it
  is on screen.

## 2. Tokens

### Colour roles

| Role | Dark | Paper | Use |
|---|---|---|---|
| `bg` | `--graphite` #0E0D0C | `--paper` #F4F1EA | Page ground |
| `panel` | `--carbon` #161513 | `--paper-raised` #FBFAF6 | Cards, sheets, the Capsule |
| `raised` | `--raised` #1E1C1A | `--paper-raised` #FBFAF6 | Agent tiles, pressed rows, the Deny reveal |
| `rule` | `--rule` #2B2926 | `--paper-rule` #DCD7CC | Hairlines between rows |
| `rule-strong` | `--rule-strong` #3A3733 | `--paper-rule-strong` #C9C3B7 | Card and input borders, outline buttons |
| `text` | `--bone` #F1EEE6 | `--ink` #141311 | Primary text, the mark's wire |
| `text-2` | `--stone` #B3AEA4 | `--ink-2` #4A463F | Secondary text |
| `text-3` | `--ash` #8C877D | `--ink-3` #6B665D | Labels, meta, placeholders. Smallest text colour allowed |
| `primary` fill / text | `--signal` #C6F36B / `--signal-ink` | `--ink` / `--paper` | The one primary button per view |
| `focus` | `--signal` | `--signal-deep` #46700C | Focus ring, match highlight tint |
| `match` | rgba(198,243,107,0.20) | rgba(70,112,12,0.16) | Search match highlight |
| `beacon` text / dot | #FF7A59 / #FF7A59 | `--beacon-deep` #C2411F / #E5532F | Needs you. Nothing else |
| `beacon-wash` | rgba(255,122,89,0.12) | rgba(194,65,31,0.08) | Behind a held item |
| `recall` text | `--recall` #EBC76B | `--recall-deep` #7E5B0C | Came from memory |
| `recall-wash` | rgba(235,199,107,0.10) | rgba(126,91,12,0.09) | Behind a recalled block |
| `scrim` | rgba(0,0,0,0.62) | rgba(20,19,17,0.34) | Behind a sheet |

The mark's dot is Signal (dark) or Ink (paper) when nothing is waiting, and Beacon when anything
needs you. A deleted line in a diff is `text-3` on `raised`, never Beacon. A failure is `text`
with a `text-3` "failed" label; it turns Beacon only when it needs the user.

Theme follows the system (`prefers-color-scheme`), with Dark, Paper and System in Settings.

### Type

Sans is Instrument Sans (400, 500, 600). Mono is JetBrains Mono (400, 500). Native apps bundle
both fonts and scale them with Dynamic Type (iOS) and font scale (Android); the sizes below are
the default "Large" size.

| Role | Family | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| Page | Sans | 22 / 28 | 600 | -0.015em | The page labels in the header (Now, Chats, Agents) |
| Sheet title | Sans | 26 / 31 | 600 | -0.02em | The detail sheet's title |
| Title | Sans | 17 / 22 | 600 | 0 | Chat header, agent names |
| Row title | Sans | 16 / 21 | 600 | 0 | Needs rows, result rows |
| Lead | Sans | 17 / 24 | 400 | 0 | Shared with the Deck: sheet "why" text on large sizes |
| Body | Sans | 16 / 23 | 400 | 0 | Chat messages |
| Secondary | Sans | 15 / 20 | 400 | 0 | Row second lines, input text is 16 or larger (no iOS zoom) |
| Meta | Sans | 13 / 18 | 400 | 0 | "kit · Harlow Legal", times, hints |
| Micro | Sans | 12 / 16 | 400 | 0 | Shared with the Deck: tile letters at small sizes |
| Label | Mono | 11 / 14 | 500 upper | +0.16em | Engraved section labels (NEEDS YOU, WORKING, REMEMBERED) |
| Command | Mono | 14 / 20 | 400 | 0 | Commands in rows and sheets |
| Log | Mono | 12 / 19 | 400 | 0 | Live console, tool rows, diff rows |
| Readout | Mono | 28 / 34 | 500 | 0 | Agents count strip |
| Button | Mono | 12 / 16 | 500 upper | +0.12em | Every button label |

### Space, shape, lines

- 4 px grid. Use 4, 8, 12, 16, 24, 32. Side gutter 16. Safe areas come from the device
  (`env(safe-area-inset-*)`); the mockups use 59 top and 34 bottom.
- Radii: chip 4, button 6, card 10, sheet 14 (top corners), agent tile 8 (at 32 px), the Capsule
  fully round. The same numbers as the Deck.
- Hairline 1 px `rule` between rows; `rule-strong` on card, input and outline-button borders.
- One shadow, for things that float (the Capsule, sheets, the top triage card):
  dark `inset 0 1px 0 rgba(241,238,230,0.06), 0 24px 48px -24px rgba(0,0,0,0.6)`,
  paper `0 24px 48px -24px rgba(20,19,17,0.28)`.
- No gradients, glows, or blur behind content. The Capsule and sheets are opaque `panel`.
- Icons: inline stroke SVG on a 24 grid, 1.5 stroke (1.7 at 26 px and above), round caps and
  joins, `currentColor`. Sizes 16, 20, 22, 26. The set the phone needs: back, more, plus, close,
  search, mic, send (arrow up), stop, check, face-id, terminal, eye, pause, clock, file, chat.
- Touch targets are 44 x 44 at least, even where the drawing is smaller.

## 3. The shell

No tab bar. Three pages side by side: **Now**, **Chats**, **Agents**. Find is not a page; it is
the Capsule, opened.

```
+--------------------------------------+
| (v)  Now   Chats   Agents       (a)  |  header, 48 tall under the safe area
|                                      |
|  page content, scrolls               |
|                                      |
|                                      |
|  ( v   Ask juno, find, or run   (mic) )  the Capsule, floating
+--------------------------------------+
```

- **Header.** The mark (22 px) on the left, then the three page labels in Page type, the current
  one in `text`, the others in `text-3`. The avatar (34 px circle, the owner's initial) on the
  right opens Settings as a sheet. On Agents the avatar's place holds "+" (new agent). The header
  does not collapse; it stays 48 tall.
- **Pages** swipe left and right with the page label snapping under the finger. Tapping a label
  jumps there. The app reopens on the page it was on, except that it opens on Now whenever
  something needs you.
- **The Capsule** floats 12 from each side, sitting on the bottom safe area, 56 tall, `panel`
  fill, `rule-strong` border, the float shadow. It holds the mark (20 px), the placeholder "Ask
  <assistant>, find, or run" (the assistant's name from onboarding), and a 40 px mic button.
  - Tap: Find opens as a full-height sheet with the keyboard up.
  - Drag up: same, following the finger.
  - Hold the mic: dictate. Release to put the words in Find; the words are never sent on their
    own.
  - Pages leave 56 + 16 of bottom padding so the last row clears it.
- **Pushed screens** (a chat, an agent's live view, Settings pages) slide in from the right, have
  a back chevron, and support the edge swipe back. In a chat the Capsule becomes the composer.

## 4. Now

Top to bottom. Any section with nothing in it is left out, except as noted.

### Needs you

A label row: Beacon dot + `NEEDS YOU` (Label type in Beacon) on the left, the count on the right.
Below it, one card (`panel`, `rule` border, radius 10) holding a row per item, oldest first, with
hairlines between rows. Under the card, one Meta line in `text-3`: "Swipe right to approve, left
to deny." Show the hint until the user has swiped once, then drop it.

The row:

```
[k]  Push q3-report                        4m  >
     git push origin q3-report                     (mono, only for a command)
     kit · Harlow Legal
```

- Tile 32 px, radius 8, `raised` fill, `rule-strong` border, the agent's initial (Row title,
  600). The tile is the agent that asked.
- Line 1: the title in Row title, time since it was held on the right in Meta `text-3`.
- Line 2: the command in Command mono `text-2` for an ask; the subject for a draft; the question
  for a question. One line, truncated at the end.
- Line 3: "<agent> · <project>" in Meta `text-3`.
- Chevron 16 px in `text-3`.
- Titles by kind: an ask is the action ("Push q3-report"); a draft is "Send email to Dana" (verb
  and person); a question is "<agent> has a question".

Swipe:

- **Right** reveals the primary action from the left edge, 100 wide, in the primary fill: the
  Face ID glyph (or passkey glyph where there is no Face ID) over "Approve" (asks), "Send"
  (drafts). Past 100 or a fast fling, it commits: the passkey prompt runs, and on success the
  row collapses. Letting go short of 100 leaves the action showing; tapping it commits.
- **Left** reveals "Deny" (asks) or "Discard" (drafts) from the right edge, 100 wide, `raised`
  fill with `text` label and an x glyph. Committing needs no passkey unless the tool demands
  one. The row collapses with an Undo toast for 4 s.
- A **question** has no one-swipe answer: swiping right opens its sheet, swiping left offers
  "Later" (snooze 1 h).
- A failed approval springs the row back and shows the reason under line 3 in `text`, with
  "failed" as a Label.
- **Tap** anywhere else on the row opens its detail sheet (section 5).

When nothing needs you, the section is one line in `text-3`: "Nothing needs you." No card.

### Working

`WORKING` label and count, then flat rows separated by hairlines (no card):

```
kit    Q3 report                    06:12
       rendering q3.pdf 4/9                 (mono, text-3)
```

A 52 px agent column in Row title, the session name in Secondary with its latest step in Log
mono below, elapsed time in mono on the right (`done` in `text-3` once finished). Tap opens the
agent's live view. Finished rows leave after an hour. When nothing is running, the most recent
two sessions stand in, as today.

### Remembered

One `recall-wash` block, radius 10: the `REMEMBERED` label in Recall, then what memory learned
today or what is due soon, in Secondary. Tap opens the fact in Find with its source.

### Setup and pairing

The passkey and "Set up this phone" cards leave Now. First run is an onboarding flow (install,
notifications, passkey). Later, anything missing is one row at the top of Now ("Add a passkey to
approve from this phone", chevron) that opens that step as a sheet. A Mac asking to pair is a
Needs you row like any other, with its own sheet.

## 5. The detail sheet

Every Needs you row opens this sheet at the large detent (top edge just under the header),
radius 14, grabber, `panel` fill, the float shadow, over the page scaled to 0.94 behind the
scrim. Swipe down or tap the scrim to close. Content scrolls; the action area stays pinned to
the bottom above the safe area.

Header (every kind):

- Row 1: `<AGENT> ASKS · <PROJECT>` as a Label on the left; **Open session** on the right as a
  Button-type text link with a chevron, 44 tall.
- Row 2: Beacon dot + "Held 4m" in Beacon Meta, and the rule that held it when there is one
  ("your rule: pushes ask first").
- Title in Sheet title.

**Open session** opens the exact session this came from in Chat, scrolled to the moment it was
raised: the matching tool row or message is centred and flashes `match` for 1.2 s. The sheet
closes first. If the session is on a Mac that is away, the button still opens the read-only
transcript and says the Mac is away in the chat header.

Body by kind:

- **Ask (a tool call).** The command in a mono block (`bg` fill, `rule` border, radius 6, `$` in
  `text-3`). Then `CHANGES` with a count ("6 files · 3 commits") and the diff summary as Log rows:
  path on the left, `+n` in `text` and `-n` in `text-3` on the right, four rows then "n more"
  (tap to expand the full diff, per file, with + lines on `match` and - lines on `raised`). Then
  `WHY` and the agent's reason in Secondary `text-2`. Then the facts the tool gives (remote,
  branch) as label and value rows.
- **Draft (held at the Gate).** To and Subject as editable fields, then the body as an editable
  text area (the same editing as the Deck, js/editable.js). The sources it drew from, if any,
  in a `recall-wash` block. An edit changes the primary to "Send edited".
- **Question.** The question in Lead type, then the choices as full-width rows (radius 10,
  `rule-strong` border, 52 tall, the choice text in Row title and its note in Meta). Tap a
  choice to select it; the last row is a free-text field ("Something else"). No number keys on
  the phone.

Action area:

- Ask: a two-way scope control (`Just this once` | `Always in <project>`), radius 6, 36 tall.
  Then the primary button, full width, 54 tall: Face ID glyph + "Approve with Face ID" ("with
  Touch ID", "with passkey" by device). Then "Deny" as a text button, 44 tall, `text-2`.
- Draft: "Send with Face ID" primary; "Discard" text button.
- Question: "Answer" primary, enabled once a choice is picked or text typed. No passkey unless
  the tool asks for one.
- The primary runs the passkey prompt (WebAuthn in the PWA, a platform passkey assertion in the
  native apps; the same presence proof per ADR 0004). On success the sheet closes, the row
  collapses and the next item's row pulses once. On cancel nothing changes.

## 6. Chats

### The list (page)

Filter chips across the top (All, then each project), chip radius 4, 30 tall: the selected one
filled with `text` on `bg`. This replaces the old Projects tab. Rows below, newest first:

- Agent tile, session name (Row title), last line (Secondary `text-2`, one line), time (Meta,
  right). A running session shows `writing` or `running` as a Label with a small `text` dot; a
  session with an open ask shows a Beacon dot and its count on the right.
- Tap opens the session. Swipe left: Archive.

### A session (pushed)

Header: back, agent tile (34), the session name (Title) with a status Label under it (`kit ·
writing`, `kit · waiting on you` in Beacon, `idle`), and a terminal button that opens the
agent's live view.

The transcript is a timeline: a 44 px gutter of times (Label mono, `text-3`), content to the
right, 16 between items.

- **Message**: a Label with the author (`you`, the assistant's name, or the agent's name; "Vyre"
  only when none is known), then the text in Body. No bubbles.
- **Tool rows**: grouped, hairlines above, between and below, no box. One Log line each: verb
  (`edit`, `run`, `read`, `search`) in `text-3` in a 34 px column, the target, the result on the
  right in `text-3`. A running row shows a 12 px spinner in place of the result. Tap expands the
  row in place: the full command, output (Log, max 12 lines, then "Show all"), or the diff.
- **Streaming**: the reply grows in Body with a 2 x 18 caret in `text` at the end.
- **Held (an ask in this session)**: a full-width band (edge to edge, no side margin),
  `beacon-wash` fill, `rule` hairlines above and below. `HELD · NEEDS YOU` in Beacon Label with
  the dot, "Details" on the right (opens the detail sheet), the command in Command mono, one
  Meta line of facts, then Deny (outline) and Approve (primary, Face ID glyph) side by side, 44
  tall. Answered, it shrinks to one Meta line: "Approved by you, 12:07" and stays in the
  timeline.
- **Question**: the same band shape with the choices as rows inside it.
- **Recalled**: a `recall-wash` block with a `REMEMBERED` label when memory fed the reply.

Composer: the Capsule becomes a 52 tall pill "Message <agent>", a 40 px round button on the
right: send (arrow up, primary fill once there is text), or stop (a square, `text` fill) while a
reply streams. The attachment button appears only once there is a keyboard. Sending resumes the
session here (the lease moves to this phone); if another surface holds it, one Meta line above
the composer says who, and sending takes it.

## 7. Find (the Capsule, opened)

A full-height sheet. At the top, the search field in the Capsule's shape (46 tall, radius 23,
the mark inside it) and "Done". Under it, scope chips: All, Chats, Files, Memory, Run.

Sections as the user types, each a Label with a hairline under it:

1. **Ask**: one row, `Ask <assistant>: <the typed words as a question>`, on a signal-wash fill,
   return glyph on the right. Return runs it: a new lean thread with the assistant, pushed as a
   chat.
2. **Run**: commands that match (`@kit ...`, `tell <session> to ...`, `watch <session>`, "New
   session on ...", "Test the intake form"), a terminal icon, the command it will run in Log mono
   below. The Deck's Find commands, same grammar.
3. **Remembered**: recalled facts in `recall-wash`, with source and date in Label mono.
4. **Chats**: sessions whose name or text matches, snippet with matches on `match`.
5. **Files**: from the paired Macs, when they are online; one Meta line says so when they are
   not.

Empty query: recent searches and the four most recent sessions. Search waits 150 ms after the
last keystroke and cancels the previous request.

## 8. Agents

- **Count strip**: three readouts in a row with hairline dividers, `WORKING`, `HELD` (in Beacon
  when above zero) and `IDLE`, each a Readout number over a Label.
- **Agent panel** (`panel`, radius 10), one per agent, working ones first:
  - Tile (36), name (Title), status Label (`WORKING · Q3 REPORT`, `IDLE · EVERY PROJECT`),
    elapsed time in mono on the right.
  - While working: the live console (`bg`, radius 6, Log mono, the last 4 lines, block caret on
    the last), a readout row (`STEP 3/5`, `TOOLS 18`, `FILES 6`), then Watch and Pause outline
    buttons, 44 tall.
  - Idle panels are one row: tile, name, status, role on the right. Tap opens the agent.
- **Schedule**: rows with the time in a 76 px mono column, the watcher's name and "agent ·
  cadence" below.
- **Watch** pushes the live view: the full console, scrollable, with the session's tool rows,
  and the same held band when it asks.

## 9. Motion

| What | How |
|---|---|
| Hover-like press feedback | Row fills `raised` for the press, 120 ms ease-out out |
| Row swipe | Follows the finger 1:1; release springs (iOS default: response 0.35, damping 1) |
| Row collapse after an answer | Height to 0 over 180 ms ease-out, rows below move up |
| Sheet open and close | iOS sheet presentation; page behind scales to 0.94 |
| Expand a tool row or diff | 180 ms ease-out |
| Page swipe | Follows the finger; snaps with a spring; label colour crossfades |
| Streaming | Tokens appear as they arrive, no fade; caret blinks at 1 s |
| Open session highlight | `match` fill on the target row, fades out over 1.2 s |
| Beacon dot on arrival | One pulse (scale 1 to 1.6 and back, 400 ms), then still |

Reduce Motion: no scale behind sheets, no pulse, swipes and pages crossfade instead of slide.
Nothing animates in the background.

## 10. Haptics (native; the PWA uses none on iOS, and `navigator.vibrate(10)` on Android only for commits)

| Moment | iOS | Android |
|---|---|---|
| Swipe crosses the commit point | `UIImpactFeedbackGenerator(.medium)` | `CONFIRM` |
| Approval or send succeeds | `UINotificationFeedbackGenerator(.success)` | `CONFIRM` |
| Deny, discard | `.warning` | `REJECT` |
| Page label snaps | `UISelectionFeedbackGenerator` | `CLOCK_TICK` |
| Hold-to-talk starts and stops | `.soft` impact | `VIRTUAL_KEY` |
| A new item needs you while the app is open | `.warning`, once, only if Now is on screen | `REJECT` |

## 11. States

- **Loading**: layout skeleton (the real card shapes in `raised`, no shimmer) for the first load
  only; later refreshes keep the old content until the new arrives.
- **Offline** (box unreachable): one line under the header, `text-2`, "Can't reach your box.
  Showing what it said at 12:04.", with Retry. Actions that need the box are disabled with the
  reason on press.
- **Mac away**: its sessions stay, read-only, with a machine chip; Open session still works.
- **Empty pages**: one sentence and a way forward. Chats: "No sessions yet." plus the Capsule.
  Agents: "Only <assistant> so far." plus "New agent".
- **Errors**: `text` with a `failed` Label and the reason; Beacon only when the user must act.

## 12. Accessibility

- Real buttons and links. Every swipe action is also in the row's accessibility actions (VoiceOver
  custom actions, Android `AccessibilityAction`) and in the detail sheet.
- Labels: a Needs row reads "kit, Harlow Legal, wants to push q3-report, git push origin
  q3-report, 4 minutes ago. Actions: Approve, Deny, Open."
- Contrast: `text-3` is the smallest text colour (5.4:1 dark, 5.0:1 paper). Beacon text on paper
  is `--beacon-deep`.
- Dynamic Type up to AX3: rows grow, the header labels shrink to fit and then scroll
  horizontally, the Capsule grows to 64.
- Focus ring: 2 px `focus`, 2 px offset.

## 13. Light by default

- Needs, Working and agents come from events (gate.held, gate.released, ask.raised,
  ask.answered, thread.*). The fallback poll is 60 s, and none while hidden.
- The live console subscribes only while an agent panel or live view is on screen, and shows at
  most 4 new lines a second.
- Transcripts load the last 50 items and page backwards on scroll.

## 14. What each build does

**pwa** (deck/, the phone layout under 600 px):

1. Shell: header with pages, horizontal page swipe (scroll-snap), the Capsule; remove the tab
   bar and the Projects tab.
2. Now: the Needs you list with swipe and Undo, Working rows, Remembered; move setup and the
   first-passkey card out of Now into onboarding plus the one-row reminder.
3. Detail sheet for ask, draft and question, with Open session.
4. Chat timeline, tool rows, held band, composer with stop.
5. Find as the Capsule sheet, with Ask, Run, Remembered, Chats, Files.
6. Agents panels and the live view.

**mobile** (native iOS and Android): the same order, with platform sheets
(`.presentationDetents([.large])`, Material bottom sheet), system swipe actions, the haptics in
section 10, Dynamic Type, and the bundled fonts.

## 15. Contracts this needs

- **Open session at the moment** needs an anchor: `threads.asks` and `gate.held` rows should
  carry the transcript event id (or the tool_use id) they came from, so Chat can scroll to it.
  Until then, Chat scrolls to the first item at or after the row's `at` time.
- **Questions** (an agent asking the user to pick) as Needs items with `options` (label, note),
  answered through the same capability id.
- **Always in <project>** needs the rule write the Deck's gate card uses; the scope control is
  hidden where the tool does not offer it.
- **Diff summary** for a held push or edit: files with added and removed counts, when the tool
  can say.
