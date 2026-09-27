---
title: The Capsule, redesigned
summary: The Design A Capsule for capsule-pro. Keyboard first, answers on pause, a follow-up box, Vyre IQ with sources, an answer card that grows then scrolls, voice on Option-Return and computer use you can stop with Esc.
audience: builders
owner: app-design
status: draft
---

# The Capsule, redesigned

The Capsule is one field over any app. Type and it finds; type a question and pause and Vyre IQ
answers from your own sessions and memory; say "do ..." and an agent uses your Mac while you watch;
hold Option-Return and talk. Everything works from the keyboard, and the footer only ever shows
keys.

This page is the whole Capsule for capsule-pro (work/capsule-pro, `local/capsule/native/`). It
builds on [Capsule on the Mac](components/capsule-mac.md), which still holds the waiting list, the
confirm send card and the presence rules. Where the two disagree, this page wins.

Boards: "Capsule · search, the first keystroke" (CapsuleSearch), "Capsule · Vyre IQ answers"
(CapsuleIQ), "Capsule · a long answer grows, then scrolls" (CapsuleLong) and "Capsule · voice and
computer use" (CapsuleDo), each with a paper board.

## Rules that never bend

1. **Nothing clips.** No text is ever cut mid-line. A card grows to the panel's height, then
   scrolls inside, with keys, the trackpad and a visible thumb.
2. **No empty headings.** A group header draws only when its group has at least one row. There is
   never a "Sends to", "Commands" or any other heading with nothing under it.
3. **The footer holds keys only.** Key hints, at most four, for what the keys do right now. Status
   goes in the row or card it belongs to, never the footer. A passing status with no row of its own
   ("Copied", "Taken back") is one 12/16 `text2` line in the body just above the footer, for 2 s.
4. **The keyboard can do everything.** Every action has a key, and the key is in its
   accessibility hint. The mouse is never required.
5. **Honest answers.** Vyre IQ answers with its sources, says "Not sure" when it is, and says when
   it found nothing. It never guesses a person, a date or a number.
6. **Tokens only.** Every colour, size, radius, font and duration comes from
   `Tokens.generated.swift`, repainted live from the hub (Appearance, below). No hand-typed value.

## The panel

| Part | Size | Tokens |
|---|---|---|
| Panel | 680 wide, 560 at most, radius 14 (`Radius.sheet`) | fill `panel`, 1 px `ruleStrong`, the float shadow, opaque |
| Input row | 56 tall, padding 0 16, gap 12 | mark 20; field 15/22 `text`; placeholder `label` |
| "Using your Mac" strip | 36, in flow under the input | fill `hover`, 13/18 `text` |
| Vyre IQ card | from 88 (thinking) up to the body's height | padding 14 16 16, bottom 1 px `rule` |
| Group header | 28, padding 0 16 | 12/16 600 `label` |
| Result row | 44 at least, padding 4 16, gap 12 | lead 24; title 13; meta 12 `label` |
| Collapsed results line | 32 | 12/16 `label` |
| Footer | 32, padding 0 16, gap 16, top 1 px `rule` | 12/16 `label`, key hints |

Top to bottom: the input row, the strip (only while an agent uses the Mac), the Vyre IQ card (only
while there is a question), the waiting list ("Needs you", only when something waits), the result
groups, the footer. The body between the input and the footer is 472 at most (560 - 56 - 32).

Placement: centred on the active screen, its top a fifth of the way down. The input never moves:
the panel grows downward only.

## Search, the first keystroke

- Opening paints from the local cache in the same frame: the waiting count first, then three
  recent items. Nothing else shows until you type.
- Every keystroke paints local results under 50 ms, from the index on this Mac: sessions, agents,
  projects, files, apps and commands. Nothing waits on the network before they show, and there is
  no spinner.
- Groups keep one order: Needs you, Sessions, Agents, Projects, Files, Apps, Commands. Extension
  groups come after Commands, in the order they registered. A group with no rows is not drawn.
- The first row is selected at once; the matched letters are 600. Rows keep their slots as you
  type and groups shrink from the bottom, so the selection never jumps.
- An exact command match answers in its row ("code northwind" shows the code, the next code and
  the ring; ⏎ copies it).
- The target chip ("@kit") and the mic sit at the input's right, and only when set or installed.
  With a target set, a short line under the input says where ⏎ sends ("Sends to kit · Harlow
  Legal"); with no target there is no line and no heading.

## Vyre IQ answers on pause

**When it asks.** Words that read as a question start a quick answer about 600 ms after typing
rests: a question word, a "?", or three words or more that nothing on this Mac matches strongly.
A single word, an exact app, file or command match, and a leading "@" or "do" never start one.
More typing lets the pending answer go (the turn is interrupted); it asks again after the next
pause. The same words never ask twice, and the last five answers come back at once.

**Where it shows.** The card opens at the top of the body, above the local results, at its
thinking height, in the same frame as the pause fires. Its header: "Vyre IQ" 12/600 `label`,
then "quick" or "deeper" 12 `label`, as the group headers are. There are no "Quick answer", "Deeper answer"
or "Follow up" rows. Once the first words arrive the local results collapse to one line ("12
local results", with ↓), once, and never jump again.

**What it calls.** `iq.ask {question, stream: true}` (ADR 0034). While it works, `iq.thinking`
stages set the thinking line; the answer streams paced to the display.

| iq.ask field | What the card shows |
|---|---|
| `answer` | the prose, 15/22 `text`, paragraphs 8 apart |
| `sources[]` | up to 3 source chips, then "+2 more"; each chip is `name` · project · when (from `ts`) |
| `sources[].session`, `seq` | a chip, or ⌘1..⌘3, opens that session in Vyre at that turn |
| `sources[].quote` | the chip's tooltip and its accessibility value |
| `abstained`, `confidence` | "Not sure" (below) |
| `known[]` | under "Not sure", what it is sure of, one line each |
| `via: "fact"` | a memory chip ("Memory: Harlow Legal bills quarterly") that opens the fact in Memory |

A source chip is 28 tall, radius 14, 1 px `ruleStrong`, 13/18 `text2`, with its key hint at the
end. Sources are the person's own sessions and memory only, never the web.

**The states.**

| State | What shows |
|---|---|
| Thinking | "Thinking" 13 `text2` with one shimmer line (static under Reduce Motion), then the stage in words: "Understanding the question", "Searching your sessions and memory", "Reading 8 passages", "Checking the answer" |
| Answered | the prose and the source chips |
| Not sure | "Not sure. Here's what I found:" then `known` and the sources. No guess. |
| Nothing found | "Nothing in your sessions or memory about this." and one row: ⌘⏎ Think deeper, "asks the deeper model, with thinking" |
| Deeper, thinking | "deeper" in the header, "Thinking · 12 s" counting; ⏎ or a click opens the thinking text |
| Box away | "Vyre IQ needs the box. Local results still work." 13 `text2`; the question is kept and asks again when the box is back |
| Stopped | Esc on a streaming answer: the words so far stay, "Stopped" 12 `label` after them |

**The follow-up box.** After an answer, ⏎ keeps the answer and empties the field, which reads "Ask
a follow-up". ⏎ there continues the same thread. Each turn shows as a right-aligned bubble (the
question, 13/18 on `hover`) then the answer; newest at the bottom; the earlier answer stays above,
its prose stepped down to `text2`.

**Think deeper.** ⌘⏎ asks the same question, or the follow-up typed, on the deeper model with
thinking on, in the same thread: `threads.model` then `threads.thinking {on: true}` then
`threads.send` (sessions, batch 3b). Until those are on main the Capsule may start a new thread
with the conversation so far; the card looks the same either way.

**Open in Vyre.** ⌘O opens the thread in Vyre's Chat on the box.

## The answer card grows, then scrolls

This is the fix for the clipped answer the person reported on 27 Sep.

- The card grows with its content, line by line, from its thinking height until the body is full
  (472 with nothing else in the body; less the collapsed results line and the waiting list when
  they show). It never has a fixed height, and there is no `maxHeight` smaller than the body.
- Past that it scrolls inside. The input, the card's header and the footer stay put. A 4 wide
  thumb in `ruleStrong` shows at the card's right edge, 3 in, while it can scroll.
- While the answer streams, the card follows the newest line. If you scroll up, it stops
  following and a "Jump to latest ⌘↓" key hint shows at the card's bottom edge until you return
  to the bottom or press it.
- Keys, while the field has focus and nothing below the card is selected: ⌘↑ and ⌘↓ go to the top
  and bottom, PageUp and PageDown move a page, ⌥↑ and ⌥↓ move three lines. The trackpad and the
  wheel always scroll the card under the pointer.
- The panel's height changes only between states, never while text streams or a key repeats
  (0 size changes while streaming). Empty, it is the input, the waiting list and the footer. The
  first result or question takes it to 560 in one step over `Motion.reveal` (150 ms), and it stays
  at 560 until the field is cleared. The card grows and scrolls inside that fixed panel.
- A test: a snapshot of a 60-line answer shows the last line whole, the thumb, and no text cut at
  the card's bottom edge; a second shows the top after ⌘↑.

## Voice: Option-Return

- **Hold** Option-Return to talk while it is down; **tap** it to talk until the next tap.
- Listening: the mark at the input's left becomes the level meter (5 bars, 2 wide, `text2`,
  neutral, never the attention colour). The words show in the field as they are heard, in `label`
  until final, then in `text`. The footer says "⌥⏎ Release to ask" (hold) or "⌥⏎ Stop" (tap) and
  "Esc Cancel".
- Final words submit as ⏎ would: a question answers at once (no 600 ms wait), a follow-up
  continues the thread, "do ..." starts computer use.
- Spoken replies (Settings, Voice, "Read answers aloud"): the answer to a spoken question is read
  aloud. The card's header shows "Speaking" with a small speaker icon; Esc, or a new question,
  stops it.
- First use, no speech key: the [credential sheet](components/credential-sheet.md)'s inline row,
  "Connect Deepgram to talk", meta "Voice needs a speech key · Kept in your vault on the box"; ⏎
  opens the secure field in place. No dialog.
- First use, no microphone grant: one row, "Vyre needs the microphone to hear you", ⏎ "Allow
  microphone". The reason shows before macOS asks, and macOS asks only after ⏎.

## Computer use: "do ..."

- "do " at the start, then ⏎, is the only way into computer use: it starts an agent that uses this Mac
  (a full agent session with hands and screen). The field keeps the words; the panel shows the
  run.
- **The strip.** 36 tall, right under the input: the running ring, "Using your Mac" 13 `text`,
  the agent's name, then "Esc Stop" at the right. It stays while the agent acts, whatever else
  the panel shows.
- **Live steps.** In the card, each step is a tool row, 28 tall, 13/18 `text2`, the verb in
  words and the target in mono where it is a name: "Opened Mail", "Clicked Compose", "Typed the
  subject". The running step has the running ring; done steps a tick. Steps follow the same grow,
  then scroll rule as an answer.
- **Holds.** A send, post, payment or delete the agent reaches goes to the waiting list as an
  ask, with Touch ID in the panel (confirm send, from capsule-mac.md). The agent waits; the step
  reads "Waiting for you: Send to dana@harlowlegal.com".
- **The menu bar mark** shows a 1.5 px ring in `focus` while an agent acts, and its tooltip reads
  "Vyre is using your Mac · Esc to stop". It shows even with the panel hidden.
- **Esc stops it.** Esc, with the panel open or from the mark's menu, calls `hands.stop` and
  `threads.interrupt` in the same frame. The strip reads "Stopped. 3 steps done." for 4 s, then
  goes. Esc never needs Touch ID.
- **Done.** The strip goes; the last row says what happened in one line ("Drafted the reply to
  Sam in Mail. Not sent."), and ⌘O opens the session in Vyre.
- **First use.** Accessibility and Screen Recording: one row each explains why, and ⏎ opens the
  right System Settings pane. No OS dialog unless dialogs are allowed.

## Keys

| Key | What it does |
|---|---|
| Control twice, or ⌥Space | open or close the Capsule |
| type | search; a question answers on pause |
| ↑ ↓ | move through the results; ↑ from the first row returns to the field |
| ⏎ | open the selected result; with the field focused and a question typed, ask now; in the follow-up box, continue the thread |
| ⌘⏎ | think deeper, always (one meaning per key); computer use starts only from "do ..." and ⏎ |
| ⌘O | open in Vyre (the thread, the session, the item) |
| ⌘1 ⌘2 ⌘3 | open a source |
| ⌘↑ ⌘↓, PageUp PageDown, ⌥↑ ⌥↓ | scroll the card |
| ⌥⏎ | voice: hold to talk, or tap to start and stop |
| A, D | on a focused ask: allow once, deny |
| Esc | stop what runs (a stream, speech, computer use); else clear the field; else hide |
| ⌘A ⌘C ⌘V ⌘X ⌘Z | the standard edit keys, in the field |

Esc is layered: it stops the newest thing running first, then clears, then hides. One press does
one thing.

**The footer, by state** (left to right, four at most):

| State | Hints |
|---|---|
| Nothing typed | ↑↓ Move · ⏎ Open · Esc Hide |
| Results | ↑↓ Move · ⏎ Open · ⌘O Open in Vyre · Esc Clear |
| Question typed | ⏎ Ask · ⌘⏎ Think deeper · ⌘O Open in Vyre · Esc Clear |
| Answer streaming | Esc Stop · ⌘⏎ Think deeper |
| Speaking | ⏎ Ask · ⌘⏎ Think deeper · ⌘O Open in Vyre · Esc Stop |
| Follow-up box | ⏎ Ask · ⌘⏎ Think deeper · ⌘O Open in Vyre · Esc Clear |
| Listening | ⌥⏎ Release to ask · Esc Cancel |
| Using your Mac | Esc Stop · ⌘O Open in Vyre |
| Computer use stopped | ⌘O Open in Vyre · Esc Clear |
| Ask focused | A Allow once · D Deny · ⏎ Review · Esc Clear |

## Appearance and the hub

The Capsule reads the hub at launch and repaints live:

- `GET /v1/appearance/theme` returns `{theme, tokens, css, version}` (ETag, 304 when unchanged).
  `appearance.resolve` over the socket gives the same.
- Repaint on `appearance.changed {version, theme}`. "system" follows macOS; "dark" and "paper"
  force one.
- `Tokens.generated.swift` is the offline fallback only, used until the first answer from vyred
  and whenever the box is away.

## Motion

Opens with opacity and a 6 pt drop over `Motion.panel` (220 ms); closes over `Motion.reveal`
(150). Text streams paced to the display, so prose never reflows in bursts. The shimmer and the
level meter stop under Reduce Motion (a static line, a static meter at the current level).

## Copy

- Placeholder: "Ask Vyre, find, or run". Follow-up: "Ask a follow-up". Card label: "Vyre IQ".
- "Not sure. Here's what I found:". "Nothing in your sessions or memory about this.". "Vyre IQ
  needs the box. Local results still work.".
- "Using your Mac". "Stopped. 3 steps done.". "Vyre is using your Mac · Esc to stop".
- Sentence case everywhere. Never caps labels ("SEND TO", "COMMANDS", "WAITING ON YOU"), never
  "Approve?", never "AI".

## Accessibility

- The panel is a group named "Vyre Capsule"; focus lands in the field on open.
- The Vyre IQ card is a live region, polite: it announces "Vyre IQ answered" once, not each word.
  Its prose is one readable element; each source chip reads "Source 1, Q3 report and Estate
  intake, Harlow Legal, Tuesday, command 1".
- The strip is a live region, assertive once when computer use starts: "Vyre is using your Mac.
  Escape to stop."
- Scrolling keys work with VoiceOver on. Text 4.5:1, the focus ring 3:1, rows 44 tall.

## Gaps

Capsule (work/capsule-pro)
- [ ] The answer at the top is capped at 200 and clipped (`CapsuleView` `answer.frame(maxHeight:
  200)`): grow, then scroll, with the keys and the thumb above, and the two snapshot tests.
- [ ] Empty "Sends to" and "Commands" headings draw with no rows: draw a header only with rows.
- [ ] Vyre IQ: call `iq.ask` with `stream: true` when memory-iq lands it; show the stages, the
  source chips (⌘1..⌘3), "Not sure" with `known`, and nothing found. Today the quick answer is a
  capsule-purpose thread with no sources.
- [ ] ⌘⏎ in the same thread with `threads.model` and `threads.thinking` once they are on main.
- [ ] The footer states table above; no status in the footer.
- [ ] Voice: the level meter in place of the mark, the "Speaking" header, the no-key and
  no-microphone rows.
- [ ] Computer use: the strip, the step rows, the menu bar ring and tooltip, "Stopped. n steps
  done.".
- [ ] Layered Esc (stop, then clear, then hide), one thing per press.
- [ ] Read `/v1/appearance/theme` and repaint on `appearance.changed`.
- [ ] Everything under Gaps in [Capsule on the Mac](components/capsule-mac.md).

memory-iq
- [ ] `iq.ask` with `stream: true` and `iq.thinking` stages, as in ADR 0034. Personal facts come
  only from the person's own words, never from dev, test or tool text; the same question gives the
  same answer; grounded or abstain.

sessions
- [ ] The capsule prompt: "You are Vyre IQ", cite or say "I don't know yet", temperature 0.
