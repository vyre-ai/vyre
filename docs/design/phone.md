---
title: Vyre phone
summary: The design for Vyre on a phone, one Expo app for iOS, Android and the web, built on the Deck's tokens.
audience: builders
owner: mobile
status: draft
---

# Vyre phone

The design for Vyre on a phone: one Expo app (React Native) for iOS, Android and the web, like
Paseo's (the user's decision, 2026-09-27; mobile leads ADR 0027). It builds from this file. Colours and type come from [TOKENS.md](TOKENS.md) and are pasted verbatim; this
file adds only phone roles, sizes and behaviour. Desktop (the Deck) shares the same tokens and
chat items, so a card looks the same on both.

Decision (2026-09-27): Direction B's shell (no tab bar, pages you swipe between, the floating
Capsule with hold-to-talk) with Direction A's screens (Chat, Find, Agents, the approval sheet).
Now is A's grouped "Needs you" list: every row swipes to approve or deny and opens a detail sheet
with Open session. The screens feel native to iOS: sentence-case sans type, grouped cards,
standard sheets. Mono is for commands, code and logs only.

## 1. What the phone is for

In order of how often it happens:

1. Glance at what needs you, and answer it (approve, deny, reply, pick a choice).
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

Role names are the Deck's (deck/css/deck.css, and the shared mockup sheet
docs/design/deck-directions/vyre.css), so a phone view and a Deck view read the same variables.

| Role | Dark | Paper | Use |
|---|---|---|---|
| `--bg` | #0E0D0C | #F4F1EA | Page ground |
| `--panel` | #161513 | #FBFAF6 | Cards, sheets, the Capsule |
| `--hover` | #1E1C1A | rgba(20,19,17,0.045) | Agent tiles, pressed rows, the Deny reveal |
| `--rule` | #2B2926 | #DCD7CC | Hairlines between rows |
| `--rule-strong` | #3A3733 | #C9C3B7 | Card and input borders, outline buttons |
| `--text` | #F1EEE6 | #141311 | Primary text |
| `--text-2` | #B3AEA4 | #4A463F | Secondary text |
| `--label` | #8C877D | #6B665D | Labels, meta, placeholders. Smallest text colour allowed |
| `--primary-bg` / `--primary-ink` | #C6F36B / #0E0D0C | #141311 / #F4F1EA | The one primary button per view |
| `--focus` | #C6F36B | #46700C | Focus ring |
| `--signal-wash` | rgba(198,243,107,0.12) | rgba(70,112,12,0.10) | The Ask row in Find, added diff lines |
| `--match` (phone) | rgba(198,243,107,0.20) | rgba(70,112,12,0.16) | Search match highlight, the Open session flash |
| `--beacon-ink` / `--beacon-dot` | #B8A4FF / #B8A4FF | #5B3FC4 / #5B3FC4 | Attention: needs you. Nothing else |
| `--beacon-wash` | rgba(184,164,255,0.12) | rgba(91,63,196,0.08) | Not used on the phone: held, ask and question cards are neutral |
| `--beacon-badge-ink` (phone) | #0E0D0C | #F4F1EA | Count text on a `--beacon-dot` badge |
| `--recall` | #EBC76B | #7E5B0C | Came from memory |
| `--recall-wash` | rgba(235,199,107,0.10) | rgba(126,91,12,0.08) | Behind a recalled block |
| `--del-wash` | rgba(140,135,125,0.14) | rgba(107,102,93,0.10) | Deleted diff lines, with `--text-2` text (`--label` is 4.49:1 there) |
| `--code-bg` | rgba(14,13,12,0.55) | rgba(20,19,17,0.04) | Command blocks, the live console |
| `--mark-wire` / `--mark-dot` | #F1EEE6 / #C6F36B | #141311 / #141311 | The mark |
| `--scrim` (phone) | rgba(0,0,0,0.62) | rgba(20,19,17,0.34) | Behind a sheet |

**No coral or red, anywhere** (the user's rule). The attention colour ("needs you") keeps the
`--beacon-*` names but is violet, deck-design's recommendation; teal is the only alternative
(honey is out, the user's rule). Swapping it is one line per theme: change the three `--beacon-*`
values. Every pair above passes WCAG AA.

The mark's dot is Signal (dark) or Ink (paper) when nothing is waiting, and the attention colour
when anything needs you. A deleted line in a diff is `--text-2` on `--del-wash`, never attention.

The attention colour is only ever a dot and a label ("kit is waiting on you", "Held 4 min").
Held, ask and question cards are neutral: `--panel` with a `--rule-strong` border, no wash.

Errors and destructive actions carry no colour:

- **A failure** is a fact, not an alarm: `--text`, a crossed-circle glyph, a `failed` Label and
  the reason. It takes the attention colour only when the user has to act on it.
- **A destructive action** (delete a project, forget a memory, remove a device) is slowed down by
  words and a second step, never by colour. The sheet says what goes, with counts ("This removes
  214 files, 41 memories and 3 sessions"). The destructive button is an outline in `--text` whose
  label carries the count ("Delete 214 files") and needs a 0.6 s hold (with a fill that tracks the
  hold, and a haptic at the end). The safe choice ("Keep it") is never the primary fill either.
  Deny and Discard on a held item are not destructive (the item can be held again, and Discard
  has Undo), so they are ordinary secondary buttons.

Buttons, the same three kinds as the Deck:

- **Primary**: `--primary-bg` with `--primary-ink` (ink on lime in dark, paper on ink in paper).
  One per view.
- **Secondary**: `--text` on `--hover`, `--rule-strong` border.
- **Ghost** (text-only, like "Details" or "Open session"): full `--text`, 600, never `--text-2`.

Text on tints: on paper, `--label` measures 4.48:1 on `--recall-wash` and `--signal-wash`,
just under AA, so meta text on a tinted block uses `--text-2` instead. Input
placeholders are `--label` at full opacity (browsers default to a lighter grey that fails).

Theme follows the system (`useColorScheme`), with Dark, Paper and System in Settings.

Every token in this file is a plain value the Expo app takes as is: colours as hex or `rgba()`
strings, sizes, line heights, radii and spacing as unitless numbers (px here are dp/pt), weights
as the strings "400" and "600", tracking as a number of points (-0.015em at 22 is -0.33). The app
keeps them in one `tokens.ts` with `dark` and `paper` objects under the role names without the
dashes (`--text-2` is `text2`); nothing in it is computed from a CSS variable at runtime.

### Type

Sans is Instrument Sans (400, 500, 600). Mono is JetBrains Mono (400, 500). The app bundles
both fonts and scale them with Dynamic Type (iOS) and font scale (Android); the sizes below are
the default "Large" size.

| Role | Family | Size / line | Weight | Tracking | Use |
|---|---|---|---|---|---|
| Page | Sans | 22 / 28 | 600 | -0.015em | The page labels in the header (Now, Chats, Agents) |
| Sheet title | Sans | 26 / 32 | 600 | -0.015em | The detail sheet's title |
| Section | Sans | 20 / 25 | 600 | 0 | Section headers on Now |
| Group | Sans | 17 / 22 | 600 | 0 | Group headers in Find and Agents; chat nav title; agent names |
| Row title | Sans | 16 / 21 | 600 | 0 | Rows in cards |
| Lead | Sans | 17 / 24 | 400 | 0 | Chat messages, a question's text (shared with the Deck) |
| Input | Sans | 17 / 22 | 400 | 0 | Search and composer text (never under 16: no iOS zoom) |
| Secondary | Sans | 15 / 20 | 400 | 0 | Row second lines, fact rows |
| Meta | Sans | 13 / 18 | 400 | 0 | "kit · Harlow Legal", times, hints |
| Micro | Sans | 12 / 16 | 400 | 0 | Chat nav subtitle, tags (shared with the Deck) |
| Button | Sans | 15 / 20 (17 on the 54 tall primary) | 600 | 0 | Every button label, sentence case |
| Command | Mono | 14 / 20 in blocks, 13 / 18 in rows | 400 | 0 | Commands |
| Log | Mono | 12 / 19 (13 / 18 in tool rows) | 400 | 0 | Live console, tool rows, diffs |

Buttons are sentence-case sans on the phone, not the Deck's mono uppercase: it is the one place
the phone departs from TOKENS.md, for the native feel the user picked.

### Space, shape, lines

- 4 px grid. Use 4, 8, 12, 16, 24, 32. Side gutter 16. Safe areas come from the device
  (react-native-safe-area-context; `env(safe-area-inset-*)` on the web); the mockups use 59 top and 34 bottom.
- Radii: chip 4, filter chip 8, code block 6 (inline) or 8 (sheet), card 10, button 10 (44 tall)
  or 12 (46 and 54 tall), segmented control 9 (segments 7), sheet 14 (top corners), agent tile 8
  (at 32 px) or 11 (at 40), chat bubble 18, the Capsule and round buttons fully round. Cards and
  sheets match the Deck; buttons are rounder, as on iOS.
- Hairline 1 px `--rule` between rows; `--rule-strong` on card, input and outline-button borders.
- One shadow, for things that float (the Capsule and sheets):
  dark `inset 0 1px 0 rgba(241,238,230,0.06), 0 24px 48px -24px rgba(0,0,0,0.6)`,
  paper `0 24px 48px -24px rgba(20,19,17,0.28)`. In React Native: `boxShadow` with the same
  string (new architecture), and `elevation: 12` as the Android fallback; drop the inset line
  where `boxShadow` is not available.
- No gradients, glows, or blur behind content. The Capsule and sheets are opaque `--panel`.
- Icons: inline stroke SVG on a 24 grid, 1.5 stroke (1.7 at 26 px and above), round caps and
  joins, `currentColor`. Sizes 16, 20, 22, 26. The set the phone needs: back, more, plus, close,
  search, mic, send (arrow up), stop, check, face-id, terminal, eye, pause, clock, file, chat.
- Touch targets are 44 x 44 at least, even where the drawing is smaller (`hitSlop` makes up the
  difference, 8 on every side for a 28 px control).

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
  one in `--text`, the others in `--label`. The avatar (34 px circle, the owner's initial) on the
  right opens Settings as a sheet. On Agents the avatar's place holds "+" (new agent). The header
  does not collapse; it stays 48 tall.
- **Pages** swipe left and right with the page label snapping under the finger. A swipe is a
  page swipe once it moves 15 horizontally and more horizontally than vertically (so a list still
  scrolls); it commits past a third of the width or at 500 pt/s, else springs back. Content that
  scrolls sideways (a code block, filter chips) keeps the swipe while it can scroll. On the web
  only a 32 px edge strip starts a page swipe, so text selection still works. Tapping a label
  jumps there. The app reopens on the page it was on, except that it opens on Now whenever
  something needs you.
- **The Capsule** floats 12 from each side, sitting on the bottom safe area, 56 tall, `--panel`
  fill, `--rule-strong` border, the float shadow. It holds the mark (20 px), the placeholder "Ask
  <assistant>, find, or run" (the assistant's name from onboarding), and a 40 px mic button.
  - Tap: Find opens as a full-height sheet with the keyboard up.
  - Drag up: same, following the finger.
  - Hold the mic: dictate. Release to put the words in Find; the words are never sent on their
    own.
  - Pages leave 56 + 16 of bottom padding so the last row clears it.
- **Pushed screens** (a chat, an agent's live view, Settings pages) slide in from the right, have
  a back chevron, and support the edge swipe back. A pushed chat hides the Capsule and shows its
  own composer (section 6).

## 4. Now

Sections have sentence-case headers in Section type (20/25, 600) with the count on the right in
Secondary `--label`, 24 above and 8 below. Cards are `--panel`, `--rule` border, radius 10, with
hairlines between rows. Any section with nothing in it is left out, except as noted.

### Needs you

Header: an 8 px `--beacon-dot`, then "Needs you", count on the right. One card holds a row per
item, oldest first. Under the card, one Meta line in `--label`: "Swipe right to approve with Face
ID, left to deny." Show the hint until the user has swiped once, then drop it.

The row:

```
[k]  Send email to Dana                    12m  >
     Q3 report, the short version
     kit · Harlow Legal
```

- 12 x 14 padding. Tile 32 px, radius 8, `--hover` fill, `--rule-strong` border, the agent's
  initial (15, 600). The tile is the agent that asked.
- Line 1: the title in Row title, time since it was held on the right in Meta `--label`.
- Line 2: the command in Command mono (13/18) `--text-2` for an ask; the subject for a draft; the
  question for a question, in Secondary `--text-2`. One line, truncated at the end.
- Line 3: "<agent> · <project>" in Meta `--label`.
- Chevron 16 px in `--label`.
- Titles by kind: an ask is the action ("Push q3-report"); a draft is "Send email to Dana" (verb
  and person); a question is "<agent> has a question".

Swipe:

- **Right** reveals the primary action from the left edge, 100 wide, in `--primary-bg` with
  `--primary-ink`: a check glyph (24) over "Approve" (asks) or "Send" (drafts) in 13/600, the
  Face ID glyph instead when `presence.required` is true and `covered` false (section 5).
  Past 100 or a fast fling, it commits: the proof runs if one is needed, and on success the
  row collapses. Letting go short of 100 leaves the action showing; tapping it commits.
- **Left** reveals "Deny" (asks) or "Discard" (drafts) from the right edge, 100 wide, `--hover`
  fill with `--text` label and an x glyph. Committing needs no presence check unless the tool
  demands one. The row collapses with an Undo toast for 4 s.
- A **question** has no one-swipe answer: swiping right opens its sheet, swiping left offers
  "Later" (snooze 1 h).
- A failed approval springs the row back and shows the reason under line 3 in `--text`, with a
  `--label` "failed".
- **Tap** anywhere else on the row opens its detail sheet (section 5).

When nothing needs you, the section is one line in `--label`: "Nothing needs you." No card.

### Working

Header "Working" and count. One card, a row per running session:

- Tile 32, the session name in Row title with the step count on the right in Meta ("3 of 5"),
  the latest step in Secondary `--text-2` ("Rendering reports/q3.pdf"), then a 3 px progress bar
  (`--rule` track, `--text` fill, radius 2) 8 below.
- A finished one reads "Done" on the right, no bar, and leaves after an hour.
- Tap opens the agent's live view. When nothing is running, the two most recent sessions stand in.

### From memory

One `--recall-wash` block, radius 10, 12 x 14 padding: a 14 px history glyph and "From memory"
in 13/600 `--recall`, then what memory learned today or what is due soon, in 15/21 `--text`. Tap
opens the fact in Find with its source.

### Setup and pairing

The passkey and "Set up this phone" cards leave Now. First run is an onboarding flow (install,
notifications, passkey or device key). Later, anything missing is one row at the top of Now ("Add
a passkey to approve from this phone", chevron) that opens that step as a sheet. A Mac asking to
pair is a Needs you row like any other, with its own sheet.

## 5. The detail sheet

Every Needs you row, and "Details" on a chat's approval card, opens this sheet at the large
detent (the page behind scales to 0.94 with rounded top corners, over black), radius 14 top
corners, grabber (36 x 5, `--rule-strong`), `--panel` fill, the float shadow, 20 side padding.
Swipe down, the close button or the scrim closes it. Content scrolls; the action area stays
pinned above the bottom safe area.

Header (every kind):

- Row 1: a 22 px agent tile and "<agent> asks · <project>" in Meta `--text-2` on the left; a 30
  px round close button (`--hover`, `--rule` border, x glyph) on the right.
- Title in Sheet title (26/32, 600, -0.015em), 12 above.
- Row 3: a 7 px `--beacon-dot` and "Held 4 min" in 15/20 `--beacon-ink` on the left; **Open
  session** with a chevron on the right, 15/600 `--text`, 44 tall.

**Open session** opens the exact session this came from in Chat, scrolled to the moment it was
raised: the matching tool row or message is centred and flashes `--match` for 1.2 s. The sheet
closes first. If the session is on a Mac that is away, it still opens the read-only transcript,
and the chat header says the Mac is away.

Body by kind:

- **Ask (a tool call).** The command in a mono block (`--code-bg` on dark, `--bg` on paper,
  `--rule` border, radius 8, 12 x 14 padding, 14/20, `$` in `--label`). Then "Why <agent> wants
  to" in 13/600 `--label` and the agent's reason in 16/23. Then fact rows between hairlines, label
  on the left in 15 `--label`, value on the right in 15 `--text`: Remote, Branch, Changes ("6
  files +412 -38", counts in 13 mono `--text-2`), Held by ("Your rule: pushes ask first"). Tap
  Changes to expand the files, each with its counts; tap a file for its diff (+ lines on
  `--signal-wash`, - lines on `--del-wash` with `--text-2` text).
- **Draft (held at the Gate).** To, Subject and Body edit in place: tap into them. There is no
  Edit button, and the only actions are Send and Discard (the same editing as the Deck,
  js/editable.js). The sources it drew from, if any, in a `--recall-wash` block. An edit changes
  the primary to "Send edited".
- **Question.** The question in Lead type, then the choices as full-width rows (radius 10,
  `--rule-strong` border, 52 tall, the choice in Row title and its note in Meta). Tap a choice
  to select it (`--signal-wash` fill, `--focus` border); the last row is a free-text field
  ("Something else").

Action area (8 between buttons, 34 bottom):

- Ask: the primary, full width, 54 tall, radius 12, `--primary-bg`: "Approve", one tap (asks
  are always `required: false`). Under it, two secondary buttons side by side, 46 tall, radius
  12: "Always in <project>" (approves and writes the rule) and "Deny". Where
  `ask.always_project` is null, Deny takes the full width.
- Held item at the Gate (a send, spend or delete of outside data): the primary follows the three presence states below,
  "Send with Face ID" (22 px glyph; "with Touch ID", "with fingerprint", "with passkey" by
  device) only when not covered; "Discard" secondary, never a proof. Drafts are held sends.
  Nothing else.
- Question: "Answer" primary, enabled once a choice is picked or text typed; "Later" secondary. No
  proof.
- When Face ID shows (the no-nag rule): only for pairing a device, reading or using a vault
  secret, outbound actions (messages, posts, emails, payments), and deleting outside data (mail,
  files, posts). In this sheet that means a held send, spend or delete at the Gate. Asks
  (Claude's permission asks and questions), edits, commands, git pushes and discards never
  prompt. The phone reads the box's `presence:
  {required, covered}` on every ask and held item and never guesses from the tool name. There
  are three states:
  - `required: false`: no proof. "Approve" or "Send" with a check glyph, one tap.
  - `required: true, covered: true`: this device proved presence recently (one proof lasts about
    30 minutes). No prompt. "Send" (or "Delete") with a check glyph, and one Meta `--text-2`
    line under the button: "Confirmed with Face ID a moment ago" ("12 min ago").
  - `required: true, covered: false`: "Send with Face ID" ("Delete with Face ID") with the glyph; the proof runs
    on tap and opens a new presence session.
  If `covered` has lapsed by the time you tap (the box refuses), the sheet asks for Face ID then,
  in place, without closing.
- A proof is the same box-verified check per ADR 0004 on every surface. The web build uses a WebAuthn passkey assertion. The iOS and Android builds use a device-key signature
  after Face ID or the fingerprint (ADR 0018): a P-256 key in the Secure Enclave or StrongBox,
  enrolled once through the Deck's passkey, signs the same message the Capsule signs, and the box
  checks it as method `device`. (A store app cannot assert passkeys for a self-hosted box's
  domain, so native never uses platform passkeys.) On success the sheet closes, the row
  collapses and the next item's row pulses once. On cancel nothing changes.
- While the answer travels, the tapped button shows a spinner and both buttons are disabled.
  If the box has not confirmed in 15 s, the sheet stays open with "Didn't reach your box. Try
  again." in Meta `--text-2`, and nothing is lost.
- Verbs: the Deck's gate card says Allow once / Always in <project> / Deny. The phone says
  "Approve" (the user's pick); both send the same decision, `allow`.

## 6. Chats

### The list (page)

Project filter chips across the top (All, then each project), 30 tall, radius 8, 13/600: the
selected one `--text` fill with `--bg` text, the others `--rule-strong` outline with `--text-2`
text. This replaces the old Projects tab. Below, one card of rows, newest first:

- Tile 32, session name (Row title), time on the right (Meta), last line (Secondary `--text-2`,
  one line), "<agent> · <project>" (Meta `--label`). A running session shows a 7 px `--text` dot
  before the agent's name; one with an open ask shows the `--beacon-dot` and its count on the
  right instead of the time.
- Tap opens the session. Swipe left: Archive.

### A session (pushed)

Nav bar, 52 tall under the safe area, hairline below, three columns: "< Chats" (17) on the left;
the session name (Title) centred with "<agent> · <project>" under it in 12/16 `--label`; a 44 px
more button on the right (rename, watch, stop, archive). The header does not show the page labels;
the edge swipe goes back.

The transcript, 16 side padding, 14 between items, a centred Meta `--label` time stamp at each
gap of more than an hour ("Today 12:01"):

- **You**: a bubble on the right, max 290 wide, `--hover` fill, `--rule` border, radius
  18 18 6 18, 10 x 14 padding, 17/22.
- **Agent**: no bubble. A 24 px tile and the author in 13/600 `--text-2` (the assistant's name,
  or the agent's name; "Vyre" only when none is known), then the text in 17/24.
- **Tool rows**: grouped in one box, `--rule` border, radius 10, hairlines between rows. One row
  each, 9 x 12 padding, mono 13/18: a 16 px check (done) or spinner (running) in `--label`, the
  action and target ("Edited reports/q3.tsx", "Ran npm test"), the result on the right in
  `--label` ("+412 -38", "42 passed"). Tap expands the row in place: the full command, output
  (mono 12/19, 12 lines then "Show all"), or the diff.
- **Streaming**: the reply grows in 17/24 with a 2 x 19 `--text` caret at the end. The box sends
  text in bursts; the app reveals what it has over 150 ms at the display rate (at least one
  character a frame), so the reply flows instead of jumping, and never lags more than 250 ms.
- **Following**: the transcript is an inverted list, so it opens at the newest item. It follows
  new items while you are within 32 of the bottom; scrolling up more than 24 stops following,
  and a 44 px round "Jump to latest" button (`--panel`, `--rule-strong` border, a down chevron)
  appears 12 above the composer on the right. Tapping it scrolls down and follows again. Older
  items load as you come within 96 of the top.
- **Tool runs**: three or more tool rows in a row collapse to one row ("Edited 4 files, ran 2
  commands") that expands in place. A single failed row never collapses.
- **Approval card (an ask in this session)**: `--panel` fill, `--rule-strong` border, no wash,
  radius 12, 14 padding, 10
  between parts. A 7 px `--beacon-dot` and "<agent> is waiting on you" in 13/600
  `--beacon-ink`, "Details" on the right, a ghost in 13/600 `--text` (opens the detail sheet). The command
  in a mono block (`--bg`, radius 6, 10 x 12, 14/20). One Meta `--text-2` line of facts ("3
  commits · 6 files · harlow-legal/reports"). Then Deny (secondary) and Approve (primary, with the Face ID
  glyph only when `presence.required` is true and `covered` false) side by side, 44 tall, radius 10, 15/600. Answered, it shrinks to one Meta line:
  "Approved by you, 12:07".
- **Question card**: the same card with the choices as rows inside it.
- **Recalled**: a "From memory" `--recall-wash` block when memory fed the reply.

Composer: a bar pinned above the keyboard or the bottom safe area, `--bg` fill, hairline above,
8 x 12 padding: a 36 px round attach button (`--hover`, plus glyph), the input (38 tall, radius
19, `--rule-strong` border, 17, placeholder "Message <agent>"), and a 36 px round button: send
(arrow up, `--primary-bg`) once there is text, stop (an 11 px square on `--text`) while a reply
streams. The Capsule is hidden in a pushed chat. The composer rides the keyboard by a transform (not a
relayout each frame), and the transcript gets the same bottom inset, so the last line stays in
view. On iOS keyboard heights under 120 (the prediction bar alone) are ignored. The input grows
to 6 lines, then scrolls. A fast flick down the transcript (over 1.5 pt/ms) closes the keyboard;
a slow drag to read does not. Sending resumes the session here (the lease moves
to this phone); if another surface holds it, one Meta line above the composer says who, and
sending takes it.

## 7. Find (the Capsule, opened)

A full-height sheet, 16 side padding, 12 between blocks:

- Top row, 52 tall: the search field (40 tall, radius 10, `--hover` fill, `--rule` border,
  magnifier in `--label`, 17 text, a clear button) and "Done" (17) on the right.
- A segmented control: All, Chats, Files, Memory, Run. 32 tall, radius 9, `--hover` track with
  a `--rule` border, 2 inset; the selected segment `--bg` with a `--rule-strong` border and
  13/600 text, the others 13 `--text-2`.

Results as the user types:

1. **Ask**: a card row: the assistant's tile, "Ask <assistant>" in Row title, the typed words as
   a question in Secondary `--text-2`, a chevron. Tap runs it: a new lean thread with the
   assistant, pushed as a chat.
2. **Run**: a card of matching commands (the Deck's Find grammar: `@kit ...`, `tell <session> to
   ...`, `watch <session>`, "New session on ..."): a terminal glyph, the plain-words action in
   Row title with matches on `--match`, the command it will run in mono 12 `--label` below.
3. **From memory**: the `--recall-wash` block, the fact with matches on `--match`, source and
   date in 12 `--label` below.
4. **Chats**: header in 17/600, then a card of sessions: name (Row title), the snippet (Secondary,
   one line, matches on `--match`), "<project> · <date>" (Meta).
5. **Files**: from the paired Macs, when they are online: file glyph, path in mono 14, "<repo> ·
   <Mac>" in Meta. One Meta line says so when the Macs are away.

Empty query: recent searches and the four most recent sessions. Search waits 150 ms after the
last keystroke and cancels the previous request.

## 8. Agents

Under the header, one Secondary `--label` line: "1 working, 1 idle".

- **Working agent card** (`--panel`, radius 10, 14 padding, 12 between parts):
  - A 40 px tile (radius 11), the name in 17/600, and under it a 7 px `--text` dot with a 3 px
    `--rule` ring and "Working on <session>" in 13 `--text-2`; elapsed time in 13 mono `--label`
    on the right.
  - The live console: `--code-bg` / `--bg`, `--rule` border, radius 8, 10 x 12, mono 12/19
    `--text-2`, the last 3 lines (the command in `--label`), a block caret on the last.
  - "Step 3 of 5" in 13 `--text-2` and a 3 px progress bar filling the rest of the row.
  - Watch (eye glyph) and Pause (pause glyph) secondary buttons side by side, 40 tall, radius 10,
    15/600.
  - The projects it may work in as chips: 13, 3 x 8 padding, radius 4, `--rule-strong` border,
    `--text-2`.
- **Idle agent**: one card row, 40 px tile, the name in 17/600 with a role tag ("Assistant", 12,
  radius 4, outline) and "Idle · sees every project" in 13 `--label`, a chevron. Tap opens the
  agent.
- **Scheduled**: header in 17/600, then a card of rows: a clock glyph (22, `--label`), the job in
  16 and "<agent> · <cadence>" in 13 `--label`, "in 14h" on the right in 13 `--label`.
- **Watch** pushes the live view: the full console, scrollable, with the session's tool rows,
  and the same approval card when it asks.

## 9. Motion

| What | How |
|---|---|
| Hover-like press feedback | Row fills `--hover` for the press, 120 ms ease-out out |
| Row swipe | Follows the finger 1:1; release springs (iOS default: response 0.35, damping 1) |
| Row collapse after an answer | Height to 0 over 180 ms ease-out, rows below move up |
| Sheet open and close | iOS sheet presentation; page behind scales to 0.94 |
| Expand a tool row or diff | 180 ms ease-out |
| Page swipe | Follows the finger; settles in 220 ms, cubic-bezier(0.25, 0.1, 0.25, 1); label colour crossfades |
| Long press on a row | 450 ms still (6 of slop) opens the row menu (Open, Archive, Rename), with a selection haptic |
| Streaming | Tokens appear as they arrive, no fade; caret blinks at 1 s |
| Open session highlight | `--match` fill on the target row, fades out over 1.2 s |
| Attention dot on arrival | One pulse (scale 1 to 1.6 and back, 400 ms), then still |

Reduce Motion: no scale behind sheets, no pulse, swipes and pages crossfade instead of slide.
Nothing animates in the background.

## 10. Haptics (iOS and Android through expo-haptics; the web uses none on iOS, and `navigator.vibrate(10)` on Android only for commits)

| Moment | expo-haptics |
|---|---|
| Swipe crosses the commit point | `impactAsync(Medium)` |
| Approval or send succeeds | `notificationAsync(Success)` |
| Deny, discard | `notificationAsync(Warning)` |
| Page label snaps, long-press menu opens | `selectionAsync()` |
| Hold-to-talk starts and stops | `impactAsync(Soft)` |
| A new item needs you while the app is open | `notificationAsync(Warning)`, once, only if Now is on screen |

## 11. States

- **Loading**: layout skeleton (the real card shapes in `--hover`, no shimmer) for the first load
  only; later refreshes keep the old content until the new arrives.
- **Offline** (box unreachable): one line under the header, `--text-2`, "Can't reach your box.
  Showing what it said at 12:04.", with Retry. Actions that need the box are disabled with the
  reason on press. The app keeps the last Now, chat list and open transcripts on the device, so
  it opens with content even offline.
- **Reconnecting**: a small pill under the header ("Reconnecting", then "Updating") with a
  spinner, never a blocking screen, gone when the catch-up lands. Retries back off from 2 s to
  60 s and stop while the app is in the background.
- **Notifications**: a push only when something needs you (an ask, a held item, a question) or a
  watched session finishes. None when you used Vyre on any surface in the last 3 minutes (the
  box shows it in the open surface instead), none for an item already on your screen, and none
  for errors. Tapping one opens the app on that item's detail sheet (also from a cold start).
  No action buttons in the notification: an answer always happens in the app, where the
  presence check can run.
  The one exception: planner alarms and timers always push and ring, even right after you used
  Vyre and through quiet hours. Planner reminders follow the rule above. The box-side rule is
  pwa's (core/push, ADR 0011).
- **Mac away**: its sessions stay, read-only, with a machine chip; Open session still works.
- **Empty pages**: one sentence and a way forward. Chats: "No sessions yet." plus the Capsule.
  Agents: "Only <assistant> so far." plus "New agent".
- **Errors**: `--text`, a crossed-circle glyph, a `failed` Label and the reason; the attention
  colour only when the user must act. Never red.

## 12. Accessibility

- Real buttons and links. Every swipe action is also in the row's accessibility actions (VoiceOver
  custom actions, Android `AccessibilityAction`) and in the detail sheet.
- Labels: a Needs row reads "kit, Harlow Legal, wants to push q3-report, git push origin
  q3-report, 4 minutes ago. Actions: Approve, Deny, Open."
- Contrast: `--label` is the smallest text colour (5.4:1 dark, 5.0:1 paper; `--text-2` on tints).
  Attention text measures 9.1:1 (dark) and 6.3:1 (paper) on the ground.
- The mockups were rendered to PNG in both themes and every text node, placeholder and icon
  was measured against its composited background: 1,048 checks, all at AA (4.5:1 text, 3:1 icons
  and 24 px text). Builds repeat the check on their real screens before shipping, and watch for
  a CSS rule like `button { color: inherit }` beating a button's own colour class (deck-design
  hit exactly this: unreadable buttons).
- Dynamic Type up to AX3: rows grow, the header labels shrink to fit and then scroll
  horizontally, the Capsule grows to 64.
- Focus ring: 2 px `--focus`, 2 px offset.

## 13. Light by default

- Needs, Working and agents come from events (gate.held, gate.released, ask.raised,
  ask.answered, thread.*). The fallback poll is 60 s, and none while hidden.
- The live console subscribes only while an agent panel or live view is on screen, and shows at
  most 4 new lines a second.
- Transcripts load the last 50 items and page backwards on scroll.

## 14. What the build does

One Expo app (mobile leads; ADR 0027) for iOS, Android and the web. The pwa team's Deck phone
layout (deck/, under 600 px) stays until the Expo web build replaces it. Order:

1. Shell: header with pages, the page swipe (react-native-gesture-handler and reanimated), the
   Capsule.
2. Now: the Needs you list with swipe and Undo, the Working card, From memory; setup lives in
   onboarding plus the one-row reminder.
3. Detail sheet for ask, draft and question, with Open session (@gorhom/bottom-sheet at a large
   snap point; the native sheet presentation on iOS where the router offers it).
4. Chat: nav bar, bubbles and agent messages, the tool-row box, the approval card, the composer
   with stop (react-native-keyboard-controller for the keyboard).
5. Find as the Capsule sheet: search field, segmented scope, Ask, Run, From memory, Chats, Files.
6. Agents: the working-agent card with its console, idle rows, Scheduled, and the live view.

Throughout: the haptics in section 10, Dynamic Type and font scale, the bundled fonts (expo-font),
and the tokens from one `tokens.ts` (section 2).

## 15. Contracts

Landed on work/chat (10604b9):

- **Anchors for Open session.** `threads.asks` (and `threads.get().asks`) items carry
  `anchor: { tool_use_id, event }`; `gate.held` items carry `anchor: { tool_use_id, event, thread,
  at }`. Chat scrolls to `anchor.tool_use_id` when there is one, else to `anchor.event`, else to
  the first item at or after `at` in `thread`. A model's MCP call has no tool_use_id yet, so gate
  items land by event or time.
- **Questions as Needs items.** `threads.asks` returns `kind: "question"` items with `questions`,
  `agent` and `thread_name`. Answer with `threads.answer { ask, decision: "allow", answers: {
  [question]: "label" | "a, b" | "typed text" } }`, or `decision: "deny"` for Later/decline. The
  ask id is the capability.
- **Always in <project>.** Show the button only when `ask.always_project` is a name (it can be null
  for a moment after `ask.raised`; the sheet adds the button when it arrives, never reflowing
  under the user's thumb mid-tap). It sends `threads.answer { ask, decision: "always", scope:
  "project" }` with the same presence check; the rule is written to that project's own
  `.claude/settings.local.json`. `ask.answered` carries `scope: "project"`, and the approval card
  then reads "Always allowed in <project>, 12:07".

Queued with chat (next session; the sha follows when it lands):

- **Diff summary.** Permission asks for Edit, MultiEdit and Write get `detail.changes: [{ file,
  added, removed }]`. A held git push in `gate.held` gets `changes: [{ file, added, removed }]` and
  `totals: { files, added, removed }` (from `git diff --numstat` of the pushed range). The sheet's
  Changes row reads the totals ("6 files +412 -38", or sums `changes` when there are no totals)
  and expands to the per-file list. With neither, the row is left out.
