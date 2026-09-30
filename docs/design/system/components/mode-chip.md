---
title: Mode chip
summary: The session mode chip (Plan first, Asks first, Edits allowed, Doesn't ask) and the provider chip (Claude · opus · subscription), in the composer and the session header.
audience: builders
owner: app-design
status: draft
---

# Mode chip

Two chips that say how a session runs. The **mode chip** names its permission mode and cycles it
with ⇧Tab. The **provider chip** names who runs it: provider, model and how it is paid for. Both
sit in the composer bar; the provider chip also sits in the session header. Drawn on "Session ·
the composer, like Claude Code", "Plan approval and modes, phone and desktop", "Session, phone
and desktop" and "Projects, phone and desktop" (defaults).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/composer.js` `.composer-mode` `.composer-model`, `deck/chat/core/composer-state.js` `modeLabel` `nextMode` (work/chat) | partial |
| App | `modeLabel` text in `apps/app/app/session/[id].tsx` (work/mobile) | partial |
| Capsule | none (work/capsule-pro) | not built |

## Anatomy

**Composer chip.** Inline flex, height 28, padding 0 8, radius 6, no border, fill none, ink
`--text-2`, base 13/18, gap 6: a 16 mode icon, the label, then either the key word "⇧Tab" in meta
`--label` (desktop, closed) or a 12 chev-d (phone, or while the menu is open).

**Header chip** (provider only). A tag-weight chip: height 24, radius `--radius-full`, border 1 px
`--rule-strong`, meta 12/16, `--text-2`, not interactive: "Claude · opus · subscription".

## Variants

**The four modes**, in ⇧Tab order. Plain words on the chip; the provider's own name in mono in
the menu row.

| Mode | Icon | Menu line | Claude | Codex |
|---|---|---|---|---|
| Plan first | eye | Reads and proposes. Changes nothing. | `plan` | read-only |
| Asks first | hand | Asks before every edit and command. | `default` | on-request |
| Edits allowed | file | Edits files in this project. Still asks for commands. | `acceptEdits` | workspace-write |
| Doesn't ask | unlock | Runs without asking. Only you turn it on. | `bypass` | full access |

A provider with no match for a mode shows that row disabled with "Not available with Codex".

**Doesn't ask** is the inverse neutral chip: fill `--text`, ink `--bg`, border `--text`, the
unlock icon in `--bg`. Calm and distinct; no violet, no lime, no warning colour, no banner, no
hold, no Face ID. Only the person switches into it: from this chip, the menu, ⇧Tab, or a
project's "Trusted" default (new sessions there start in it). Agents, teammates and Claude's own
sessions never can. Vyre's floor and the Gate still apply: sends, posts and payments are held for
you, and protected files are still refused. The menu's last line says so, with the shield icon.

**Provider chip.** "Provider · model · auth": "Claude · opus · subscription", "Claude · sonnet ·
API key", and for Codex its name, model and auth in the same order. The composer shows "Claude
· opus" with chev-d and opens the model picker; the header shows all three parts. A limit fallback to the API key shows
as a line in the turn, and the chip's auth word changes.

## Sizes

| | Desktop | Phone |
|---|---|---|
| Composer chip | 28 | 44 tall, radius `--radius-button-touch` (10), padding 0 12, base 13/18 |
| Header provider chip | 24 | 24, in the session header's meta line |
| Mode menu | popover 330 wide, rows 9 14 padding | a sheet with 44 minimum rows, read 17/24 |

## States

- **Default.** Ink `--text-2`, no fill.
- **Hover** (pointer). Fill `--hover`, ink `--text`.
- **Open** (`aria-expanded="true"`). Fill `--hover`, ink `--text`, chev-d shown, the menu
  anchored above it (popover). The current row has `--signal-wash` and a check.
- **Focus.** 2 px outline `--focus`, offset 2.
- **Changing.** Optimistic: the chip shows the new mode on the frame of the key or tap. If the box
  refuses, it flips back and one line says why ("The mode applies to a running session.").
- **Not running.** The chip still shows and sets the mode the next turn starts in.
- **Offline.** The change queues through the outbox; the chip shows the new mode with the queued
  line under the composer.
- **Doesn't ask, hover and open.** The fill stays `--text` and the ink `--bg`; focus adds the
  ring.

## Keyboard and touch

- ⇧Tab anywhere in the session cycles Plan first, Asks first, Edits allowed, Doesn't ask, then
  back to Plan first.
- Click or Enter opens the menu; ↑ ↓ move, ⏎ picks, Esc closes. The menu header reads "Mode for
  this session" with the ⇧Tab chip and "cycles".
- Phone: tap opens the sheet; the chip is the phone's ⇧Tab. No long press.

## Motion

The label swaps in place with no width animation (the chip resizes on the next frame). Menu opens
over `--motion-panel` on desktop, `--motion-sheet` on the phone. Reduced motion: instant.

## Copy

Exactly: "Plan first", "Asks first", "Edits allowed", "Doesn't ask". Menu header "Mode for this
session". Floor line: "The floor and the Gate apply in every mode, Doesn't ask too: sends, posts
and payments are still held for you, and protected files are still refused." Never "YOLO",
"bypass" on the chip, "Danger", "Unsafe", "Accepts edits" or "Plan mode".

## Accessibility

- Mode chip: a button with `aria-haspopup="menu"`, name "Mode: Asks first", `aria-keyshortcuts`
  "Shift+Tab". Each change is announced politely ("Mode: Doesn't ask").
- Menu: `role="menu"`, rows `menuitemradio` with `aria-checked`.
- Inverse chip: `--bg` on `--text` passes AA in both themes.

## Gaps

- [ ] Deck (work/chat): labels are "Accepts edits" and "Plan mode"; use "Edits allowed" and
  "Plan first". The order is default, acceptEdits, plan; use plan, default, acceptEdits, bypass.
- [ ] Deck (work/chat): ⇧Tab never reaches Doesn't ask, and the box's `threads.mode` refuses
  bypass (ADR 0030); the 27 Sep decision needs a person-only path in core (proposed) and an ADR
  update.
- [ ] Deck (work/chat): no inverse chip, no mode icons, no menu (the chip only cycles); the model
  chip shows the model only, not provider and auth.
- [ ] App: the mode is a text line under the composer and the header chip is "agent · provider ·
  model · project"; build both chips and the mode sheet.
- [ ] Capsule: none; the session panel needs the provider chip at least.
- [ ] System: the composer chip radius 6 is not a token; add one or use `--radius-button`.
