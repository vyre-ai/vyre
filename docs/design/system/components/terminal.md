---
title: Terminal
summary: The session's real terminal in an xterm frame, with a phone key bar, one device owning the size, and a screen that survives disconnects.
audience: builders
owner: app-design
status: draft
---

# Terminal

The same session's pty, one tab away from the transcript (Session | Terminal | Files). It is a
real terminal: xterm, full colour folded onto the tokens, a key bar on the phone. Drawn on
"Session, phone and desktop" (Phone B).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/chat/term.js`, `deck/chat/term.css`, `deck/chat/lib/term-link.js` (work/chat) | partial |
| App | none | not built |
| Lumen | not used | not used |

## Anatomy

1. **Header** (phone `ph-nav`, 44): Back, "kit · Terminal" (read 600), and the path state right
   (`st`: run dot and "direct", or "relay").
2. **Size owner line** (only while another device owns the size): min height 44, padding 6 16, 1 px
   `--rule` top and bottom: eye icon, "This phone is watching. Size is owned by alex's MacBook Pro"
   (meta, `--text-2`, grows), **Take size** (outline, 32).
3. **Screen**: xterm on `--code-bg`, padding 12 14, JetBrains Mono 12/18, `--text`. Canvas renderer
   on iOS (WebGL contexts are lost under memory pressure). Scrollback 5,000 lines.
4. **Key bar** (phone, touch screens only): `--panel`, 1 px `--rule` top, padding 8, a grid of 7
   columns, gap 6, two rows:
   - Esc, Tab, Ctrl, Alt, ↑, ↓, Paste
   - /, |, ~, -, ←, →, Enter

   Each key: radius 6, `--hover` fill, mono 12/16 `--text`, centred.
5. Safe area under the key bar in `--panel`.

**Colour mapping.** Prompt user and host in `--label`, path in `--text-2`, `$` and success marks
in `--focus`, output in `--text`. ANSI colours fold onto these roles and bone; no other hue, and
never the beacon colour.

## Variants

- **Desktop**: the Terminal tab fills the detail column; no key bar; no header row (the top bar
  holds the tabs). The size owner line sits above the screen at 32 tall.
- **Phone**: as the anatomy, the key bar docked above the home indicator and moving with the
  keyboard.
- **Watching** (not the size owner): the screen draws at the owner's size, scaled down to fit and
  letterboxed on `--bg`, never reflowed.

## Sizes

Keys draw 34 tall with a 6 gap, so each cell is 40 by about 48 on a 390 phone; the hit area fills
the cell. This is the one exception to the 44 minimum, the same trade the system keyboard makes.
Screen type is mono 12/18 on every surface.

## States

- **Live**: header dot `--focus`.
- **Connecting** or **reconnecting**: header dot `--label` with "connecting"; the screen stays.
- **Catching up** after a drop: the screen stays drawn and dims to 55% opacity while the box
  replays what was missed (the last 64 KB); keys typed meanwhile are held (up to 4 KB) and sent
  once it has caught up. No blank screen, no spinner over it.
- **Ctrl or Alt latched**: the key shows `--signal-wash` with a 1 px `--focus` inset until the
  next key.
- **Ended**: screen at 70% opacity, one line "This terminal has ended" with New terminal
  (secondary); key bar hidden.
- **Box updated**: one line "The box updated, so this shell ended" with Open a new one here.
- **Blocked** (no WebSocket on this path): the screen hides, a centred note "This path to the box
  does not carry terminals" with Try again.
- **Error**: plain words from the box ("Eight terminals are already open. Close one first.") with
  the failed mark. Never red, gold or violet.

## Keyboard and touch

Everything types into the pty. ⌘` switches Session and Terminal. Key bar buttons never take focus
from the terminal (pointer down is prevented). Paste reads the clipboard once per tap. Take size
makes this screen the owner at its fitted size; the old owner becomes a watcher.

## Motion

Only the catching-up dim (opacity at `--motion-tap`, 120). Cursor blink stops under reduced motion.

## Copy

"This phone is watching. Size is owned by alex's MacBook Pro", "Take size", "This terminal has
ended", "New terminal". Device names are names, never colours.

## Accessibility

- Screen: `role="application"` with `aria-label="Terminal, kit, harlow-legal"`; xterm's screen
  reader mode on when the OS asks for it.
- Key bar: `role="toolbar"`, `aria-label="Terminal keys"`; arrows labelled Left, Up, Down, Right;
  Ctrl and Alt are toggle buttons with `aria-pressed`.
- `--text` on `--code-bg` passes AA at 12.

## Gaps

Deck (work/chat)
- [ ] Key bar is one row of nine (Esc Tab Ctrl Alt ← ↑ ↓ → Paste); spec: two rows of seven with
      / | ~ - and Enter.
- [ ] Watch line reads "Watching at 120x40 · Take size"; spec: names the owner device.
- [ ] Connecting dot uses the gold `--recall`; error and blocked dots use `--beacon-dot`; spec:
      `--label` and the failed mark.
- [ ] xterm font 13 with line height 1.2; spec: mono 12/18.

App (work/mobile)
- [ ] Not built.

Lumen (work/capsule-pro)
- [ ] Not used: Lumen opens the terminal in the Deck.
