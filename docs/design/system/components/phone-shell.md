---
title: Phone shell
summary: The app under 720 px, with a header of page labels, three pages you swipe, the floating Lumen, the Places sheet and pushed screens.
audience: builders
owner: app-design
status: draft
---

# Phone shell

Under 720 px the app is three pages you swipe (Now, Chats, Agents), a header that names them, the
floating Lumen at the bottom, and every other place pushed over the pages or opened from the
Places sheet. Layout reads the window width, never the platform. Drawn on "Layout", "Needs you
(home)", "Agents and their computers", "Planner" and "States".

| Surface | Implementing file | Status |
|---|---|---|
| Deck | `deck/js/app.js`, `deck/css/deck.css`, `deck/js/capsule.js`, `deck/js/sheet.js` (work/pwa) | partial |
| App | `apps/app/app/_layout.tsx`, `apps/app/app/(tabs)/_layout.tsx`, `apps/app/app/places.tsx`, `apps/app/src/ui/Screen.tsx` (work/mobile) | partial |
| Lumen | not used | not used |

## Breakpoints (the whole app)

| Width | Shape |
|---|---|
| under 720 | this shell: pages, Lumen, pushed screens, bottom sheets |
| 720 to 1099 | rail and list; the detail replaces the list below 900 and sits beside it from 900; sheets become centred cards |
| 1100 to 1399 | rail 72, list 320 (resizable 240 to 480), detail capped at 820 |
| 1400 and up | adds the side panel, 340; the list hides first when the detail would drop under 480 |

## Anatomy

1. **Frame.** `position: fixed; inset: 0`, height `100dvh`, `viewport-fit=cover`. Only inner
   lists scroll, with `overscroll-behavior: contain`.
2. **Header**, 48 tall under the top safe area, padding 0 16, gap 14, `--bg`: the mark (22; its
   dot `--beacon-dot` while anything needs you, else `--mark-dot`), then the page labels Now,
   Chats, Agents at 22/28 600 (current `--text`, others `--label`), then the avatar at the right:
   a 34 circle (initial 15/600 on `--hover`, 1 px `--rule-strong`) in a 44 hit area. On Agents
   the avatar gives way to a "New agent" icon button (44).
3. **Pages.** A horizontal strip, one page per 100% width, `scroll-snap-type: x mandatory`,
   `scroll-snap-stop: always`. Body padding 8 16 0, section gap 12; bottom padding clears the
   Lumen (56 + 12 + the bottom safe area).
4. **Lumen.** Floating, 12 from each side (plus the side safe areas), bottom on the safe area,
   height 56, radius `--radius-full`, fill `--panel`, 1 px `--rule-strong`, shadow `--float`,
   padding 0 8 0 18, gap 10: the mark, the placeholder at 17/24 `--label` ("Ask juno, find, or
   run"), and the mic, a 40 circle on `--hover` with the mic icon 20 `--text`.
5. **Places sheet**, from the avatar: scrim `--scrim`; sheet `--panel`, top radius
   `--radius-sheet` (14), shadow `--float`, grabber 36 by 5 `--rule-strong` 6 from the top. Head
   row (padding 12 16 8): avatar 34, name 17/600, the box address and path at 12 `--label`
   ("vyre.harlow.ts.net · direct 12 ms"). A 3-column grid of tiles (gap 8, padding 8 16):
   Projects, Planner, Memory, Vault, Devices, Settings. Tile: 1 px `--rule`, radius 10, padding
   12, icon 20 over the label 13, centred. Hint under it, 12 `--label`.
6. **Pushed screen.** Opaque `--bg` over the pages. Nav row 44: back chevron (44 target, with the
   previous page's name at 17 when it fits), the title 17/600 truncating, one optional right item
   (an icon button or a status pill). The header and page labels hide.

## States

- **Opens on Now whenever something needs you**; otherwise it reopens where you were.
- **Listening** (mic held): mic fill `--primary-bg`, icon `--primary-ink`; the placeholder turns
  `--text` and shows the words as they come.
- **Lumen on pushed places**: stays, with a place-specific placeholder (Planner: "alarm 7am,
  todo, remind me"). Hidden where the screen has its own input (a session's composer, Glass take
  over, a sheet).
- **Pinned fourth page**: a long-pressed tile joins the strip after Agents and its label joins the
  header (the labels scroll sideways if they overflow; they never shrink).
- **Offline**: the pill sits under the header (see states); nothing else in the shell changes.

## Keyboard and touch

- Page swipe commits past a third of the width or on a flick faster than 500 pt/s; short of that
  it springs back. Tapping a label jumps to that page. A touch that starts in a swipeable row, a
  field or a sideways scroller holds the strip still.
- Pushed screens go back with the chevron or an edge swipe from the left 24 pt, with the same
  third or 500 pt/s rule.
- Lumen: tap opens Find; drag up opens it following the finger; hold the mic 600 ms
  (`--motion-hold`) to dictate, release to put the words in Find without sending.
- Places tile: tap opens the place pushed; long-press (600 ms) pins or unpins it as a fourth page.

## Motion

Swipes run on the compositor (scroll-snap). Push and pop slide over `--motion-panel` (220) with
`--ease`; sheets over `--motion-sheet` (280) and follow the finger. Three pages stay mounted (one
when memory is low). Keyboard: a `visualViewport` inset moves the composer by transform in the same
frame. Reduced motion: pushes and sheets fade, swipes still snap.

## Copy

- Page labels: Now, Chats, Agents. Places: Projects, Planner, Memory, Vault, Devices, Settings.
- Hint: "Long-press a tile to pin it as a fourth page."
- Lumen placeholder: "Ask juno, find, or run" ("Ask Vyre, find, or run" with no assistant).
- Never a bottom tab bar, a hamburger, or "More".

## Accessibility

- Page labels are links with `aria-current="page"` on the current one; off-screen pages are
  `inert` and `aria-hidden`.
- The avatar is a button named "Places and account"; the Places sheet is a `dialog`.
- Lumen is a button named by its placeholder; the mic is named "Hold to dictate".
- Every control 44 minimum; body text 17, so iOS never zooms on focus.

## Gaps

Deck (work/pwa)
- [ ] Switches at 760 px, not 720.
- [ ] The avatar opens a Settings sheet, not the Places sheet; there is no pin-a-fourth-page.
- [ ] Header gap is 12 and padding 0 12 0 16 (spec 14 and 0 16).
- [ ] Push and pop run 300 and 240 ms on their own curves, not `--motion-panel` and `--ease`.
- [ ] Lumen hides on every pushed screen, including Planner.

App (work/mobile)
- [ ] A bottom tab bar (Now, Chats, Agents) instead of the header labels and page swipe.
- [ ] No floating Lumen; Places is a modal screen, not a bottom sheet.
- [ ] Instrument Sans is not loaded, so labels render in the system font.
