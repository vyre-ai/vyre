---
title: Command bar
summary: The one entry for jumping, finding and asking, as the ⌘K bar and palette on the desktop and as the phone Lumen opened into Find.
audience: builders
owner: app-design
status: draft
---

# Command bar

One box that jumps to anything, finds anything, runs a command or asks the assistant. On the
desktop it is the trigger in the top bar and the palette ⌘K opens; on the phone it is the
floating Lumen, and pulling it up opens Find. Same words and same result order on both. Drawn
on "Needs you (home)", "Layout" (the Places table) and every desktop board's top bar. The Mac
Lumen is its own component (see capsule-mac).

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/views/find.js`, `deck/css/views/find.css`, `deck/js/capsule.js`, `deck/js/commands.js` (work/pwa); `.search` in `deck/js/app.js` (main) | partial |
| App | none in `apps/app` (work/mobile) | not built |
| Lumen | see capsule-mac | not used |

## Anatomy

**Desktop trigger** (in the top bar's centre column, 440 wide):
1. Height 34, radius `--radius-field` (8), fill `--hover`, padding 0 6 0 12, gap 8.
2. Search icon 16 `--label`; the placeholder at 13/18 `--label`, truncating:
   "Jump to anything, or ask juno" (the assistant's name; "Vyre" when there is none).
3. Key hint "⌘K" at the right (kbd chip, 20 tall).

**Desktop palette** (opened; proposed shape, not drawn on a board):
1. A centred card 640 wide, top at 12% of the window, `--panel`, radius `--radius-card`, shadow
   `--popover`, no scrim (the page stays visible, not dimmed).
2. Input row 48: search icon, input 15/22 `--text`, "esc" hint. Under it one line, 12 `--label`,
   saying what Enter will do ("Ask juno", "Open Harlow Legal / intake", "Run: tell kit to …").
3. Results in list-row shape (44 tall), grouped under 12/600 `--label` headers.

**Phone Find** (Lumen opened):
1. A sheet from Lumen to 8 below the top safe area, `--panel`, top radius `--radius-sheet`
   (14), shadow `--float`.
2. Top row: the box (17/24, 44 tall) and "Done" (ghost, back to where the sheet came from).
3. Scope, a segmented control: All, Chats, Files, Memory, Run.
4. The plan line, then the sections.

## Variants

- **Empty box**: recent searches (last 8, per device) and the 4 most recent sessions, then agents.
- **Typing** (2 characters or more, 180 ms after typing stops): sections in this fixed order:
  Ask (the assistant), Run (commands in plain words, the command in mono under each), Sessions,
  Files, Agents, From memory, Projects. Stale answers are dropped by sequence.
- **Codes** (proposed): "code northwind" shows the authenticator row (see otp) when the vault is
  unlocked on this device; locked, one row "Unlock the vault to see codes".

## States

| State | Look |
|---|---|
| Trigger default | `--hover` fill, `--label` text |
| Trigger hover | fill `--rule` |
| Trigger focus / open | 1 px `--focus` border plus 1 px `--focus` ring, as `.inp-focus` |
| Result selected | row fill `--signal-wash`, meta steps up to `--text-2` |
| Loading | results keep the previous answer; a 14 px spinner in the input row after 300 ms |
| Offline | Ask and Run rows show "Queued · sends when the box is back"; local results only |
| No results | one line: "Nothing for "<query>"" and the Ask row stays first |

## Keyboard and touch

- ⌘K opens it from anywhere; ⌘K again or Esc closes and returns focus where it was.
- ↑ ↓ move, ⏎ runs the selected row (the top row is selected on open), ⌘⏎ asks the assistant
  with the text as typed. Tab moves between scopes on the phone layout.
- Phone: tap Lumen to open; drag up to open following the finger; a pull-down from the top
  of any page also lands here. Holding the mic dictates into the box without sending.
- "@kit …" targets that agent; "tell <session> to …" types into a session.

## Motion

Desktop palette: opacity and 8 px rise over `--motion-panel` (220) with `--ease`. Phone sheet:
rises over `--motion-sheet` (280), follows the finger on drag, settles on release. The keyboard
rises in the same tap (a hidden 16 px proxy input takes focus first). Reduced motion: fade only.

## Copy

- Placeholder, desktop: "Jump to anything, or ask juno". Phone Lumen: "Ask juno, find, or run".
- Section headers: Ask, Run, Sessions, Files, Agents, From memory, Projects, Recent.
- Never "Search…", "Type a command", "AI", or "Copilot".

## Accessibility

- The trigger is a button named by its placeholder, with `aria-keyshortcuts="Meta+K"`.
- The palette is `role="dialog"` with a `combobox` input and a `listbox` of results
  (`aria-activedescendant`), each group a labelled `group`.
- Inputs are 16 px or larger on the phone so iOS never zooms.

## Gaps

Deck (work/pwa)
- [ ] Desktop has no ⌘K palette: ⌘K focuses a 420 px field in the top bar with a dropdown, and
  Find is a separate full page ("Find or ask").
- [ ] Desktop placeholder reads "Find or ask", not "Jump to anything, or ask juno".
- [ ] Phone switch is at 760 px (`PHONE_QUERY`), not 720.
- [ ] Vault codes never show in Find; the Layout board places codes in Find on the phone.

App (work/mobile)
- [ ] No Find, no command bar, no Lumen.
