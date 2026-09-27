---
title: Glass mini-view
summary: "What the agent is doing now": a small live frame of an agent's screen with its current step line, on Now, in a thread, in the Capsule as a pill and on the phone. A chat tool row links to its step.
audience: builders
owner: app-design
status: draft
---

# Glass mini-view

When an agent is using a computer, the person can see what it is doing without opening Glass: a
small live picture of its screen and one line saying the step it is on. Tap it and Glass opens at
full size. It is read only: watching changes nothing and asks for nothing. The data is cohesion's
`sight` module (ADR 0036): `sight.watch` or `sight.frame` for the picture, `sight.stepped` for the
line.

| Surface | Implementing file | Status |
|---|---|---|
| Deck | Now's agent row and the thread's header (work/pwa, work/chat) | not built |
| App | the Now screen and the thread (work/mobile), from `sight.frame` stills | not built |
| Capsule | the step pill (work/capsule-pro); the Mac's own screen is never shown | not built |

## Anatomy

**Mini frame.** 16:10, radius 8, fill `--code-bg`, 1 px `--rule-strong`, `overflow: hidden`, the
picture letterboxed on `--code-bg`, never cropped. At the top left, 8 in, the Live badge from
glass-frame.md at its small size (height 20, "Live" 12/16 600). No other chrome on the picture.

**Step line.** Under the frame, 8 below, one line 13/18: the status mark (running ring while the
step runs, a tick when `ok`, the failed mark when not), the step's `summary` in `--text` (for
example "Clicked Compose in Mail"), then a middle dot and the age 12 `--label` ("now", "4 s").
It truncates with an ellipsis; the full summary is the tooltip. A failed step adds `why` on a
second line, 12 `--text-2`.

**Holder line** (only while a person holds the keyboard, from `holder`): "alex has the keyboard"
12 `--text-2` in place of the age.

## Variants and sizes

| Variant | Where | Frame | Picture |
|---|---|---|---|
| Card | Now, one per acting agent, under its agent row | 240 wide (desktop), the screen width minus 32, drawn outside any card (phone) | `sight.watch` live on desktop; `sight.frame` still every 2 s on the phone |
| Header | a thread whose agent has a computer, under the thread's top bar, collapsible | 320 wide, right aligned | `sight.watch` live |
| Pill | the Capsule, and the phone's thread when the frame is collapsed | no picture: a pill 28 tall (pill.md's shape) with the status mark and the step line at 13 `--text`, not pill.md's meta size | none |

The Capsule never draws a picture of the user's own Mac (`sight.watch` answers `local_only`); for
an agent's computer it shows the pill, and ⌘O opens Glass in the Deck.

## States

| State | What shows |
|---|---|
| Acting | the picture live, the step line with the running ring |
| Between steps | the last step with its tick and age |
| Waiting for you | the done dot (hollow, status-mark.md), and the step line reads "Waiting for you: Send to dana@harlowlegal.com"; the waiting row (needs-row.md) owns the attention, the mini-view stays quiet |
| Person holds the keyboard | the holder line; the frame gains the take-over bar only in full Glass |
| Picture unavailable (phone over the relay, a slow link) | the last still, dimmed to 60 %, with no Live badge, and "Picture paused · steps still live" 12 `--label` |
| Done | the frame stays for 30 s with the last step, then collapses to the pill (a tick), then leaves with the run |
| Stopped | no Live badge; "Stopped. 3 steps done." then it leaves after 4 s |

## Linking

- A chat tool row (tool-row.md) whose tool acted on a computer carries the step's `call`. Its
  trailing "Step" link (12 `--text-2`, or ⌘⇧S on the focused row) scrolls the header frame to that
  step and shows the step line for it, or opens Glass at that step when the frame is closed.
- The mini frame, the step line and the pill all open Glass for that computer (⏎ when focused).

## Keyboard and touch

The mini-view is one button: "Open Glass for kit's computer". Tab reaches it after the agent row;
⏎ opens Glass. The header variant's collapse is its own icon button, a chevron ("Hide screen", "Show screen").
On the phone the whole card is the target (44 at least).

## Motion

The picture replaces in place with no fade (live frames never cross-fade). The step line swaps its
text with a 150 opacity change; it never slides. The ring stops under reduced motion.

## Copy

"Live", "Waiting for you: <what>", "alex has the keyboard", "Picture paused · steps still live",
"Stopped. 3 steps done.", "Open Glass for kit's computer", "Hide screen", "Show screen", "Step".
Step summaries are the acting module's own words (never screen text).

## Accessibility

- The picture has `aria-hidden` and the button's name carries the meaning; the step line is a
  polite live region that announces a new step at most once every 5 s ("kit: Clicked Compose in
  Mail").
- No screen text, field values or URL queries are ever read out: steps carry only the summary.

## Gaps

Deck (work/pwa, work/chat)
- [ ] Nothing built: the card on Now, the thread header frame, the tool row's Step link.

App (work/mobile)
- [ ] Nothing built: the card from `sight.frame` stills, the pill when collapsed.

Capsule (work/capsule-pro)
- [ ] Nothing built: the step pill for an agent's computer, ⌘O to Glass.

System (app-design)
- [ ] The GlassMini board on the canvas.
