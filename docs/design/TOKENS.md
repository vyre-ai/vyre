---
title: Design tokens
summary: The colour, type, shape and mark tokens every Vyre surface uses, with the values to paste verbatim.
audience: builders
owner: docs
status: stable
---

# Design tokens

Direction: Instrument, reduced. Mark: **Lead** (one wire bent into a v, with the signal dot leaving its end).
Take values from the palette, never retype them. Do not add colours. Artboards: `project/IdMarks`, `IdSystem`, `IdVoice`.

## Colour: dark (default)

The palette lives in `core/config/theme.js`, and these tables are drawn from it. The Deck paints
the same values (a test holds `deck/css/deck.css` to them). To change a colour on your box, set
it under `theme.colors` in `~/.vyre/config.json`, for example
`"theme": { "colors": { "dark": { "signal": "#B8E65A" } } }`, and reload the Deck: the box
serves your overrides as `/theme.css`. A value that is not a plain CSS colour is ignored.

<!-- colors: dark -->

Errors are not coral. A failed run is Bone text with an Ash `failed` label; if it needs the user's action, it becomes Beacon.

## Colour: light (paper)

Paper swaps the roles the views use, so its names are roles (`bg`, `text`, `focus`), and these are
the keys for `theme.colors.light`.

<!-- colors: light -->

On paper the mark is one colour: ink wire and ink dot.

## Type

Google Fonts link (one `<link>`, in `<helmet>`):

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap">
```

- Sans: `'Instrument Sans', 'Helvetica Neue', Arial, sans-serif` (400, 500, 600)
- Mono: `'JetBrains Mono', ui-monospace, Menlo, monospace` (400, 500)

Kept both. Instrument Sans has narrow, slightly drawn terminals that sit well beside the monoline wordmark; JetBrains Mono renders terminal output in Glass and the CLI at 12-13px better than any other free mono.

| Role | Family | Size / line | Weight | Tracking |
|---|---|---|---|---|
| Display | Sans | 72 / 76 | 600 | -0.035em |
| H1 | Sans | 44 / 48 | 600 | -0.03em |
| H2 | Sans | 28 / 34 | 600 | -0.02em |
| H3 | Sans | 20 / 26 | 600 | -0.01em |
| Body | Sans | 15 / 22 | 400 | 0 |
| Small | Sans | 13 / 18 | 400 | 0 |
| Label (engraved) | Mono | 11 / 14 | 500, UPPERCASE | +0.16em, colour `--ash` |
| Code / log | Mono | 13 / 20 | 400 | 0 |
| Hero command | Mono | 60-76 / 1.12 | 500 | -0.03em |

Buttons: Mono 12/16, 500, uppercase, +0.12em.

## Shape

| Token | Value | Use |
|---|---|---|
| `--r-0` | `0` | Rules, table rows |
| `--r-1` | `4px` | Chips, keycaps, swatches |
| `--r-2` | `6px` | Buttons, inputs |
| `--r-3` | `10px` | Panels, Capsule |
| `--r-4` | `14px` | Windows (Glass, Deck frames) |
| App icon | `rx = 22.46%` (230 of 1024) | |

Spacing: 4px base. Use 8, 12, 16, 24, 32, 48, 72. Page side gutter 72px desktop, 16px phone.

## Lines and light

- Hairline: `1px solid #2B2926`. Separate with rules, not nested boxes. A box inside a box is a bug.
- Strong: `1px solid #3A3733`.
- Primary: Bone (30 Sep 2026, user's pick): no accent hue. Dark: cream `#F1EEE6` fill, `#0E0D0C` ink, hover `#FFFFFF`. Paper: ink `#141311` fill, `#F4F1EA` ink. Focus, washes and the mark dot use the same neutral. On Deep glass a chip has no wash and focus is two-tone (see chip.md). A repo test fails if the retired accent returns.
- Focus: `outline: 2px solid #F1EEE6; outline-offset: 2px;` (paper: `#141311`).
- Light drawn once (top edge only, on windows and the Capsule):
  `box-shadow: inset 0 1px 0 rgba(241,238,230,0.06), 0 24px 48px -24px rgba(0,0,0,0.6);`
- Popover: `box-shadow: inset 0 1px 0 rgba(241,238,230,0.05), 0 12px 24px -12px rgba(0,0,0,0.55);`
- No gradients, glows or blur behind content. No animated backgrounds.

## Mark: Lead

Construction (24 grid): V apex (12, 19.5), arms to (3.5, 5.5) and (20.5, 5.5), stroke 2.4, round caps and joins. The right arm stops 4.9 units short of its end; the dot (r 2.3) sits at the end. Clearspace: two dot diameters on every side. Minimum size 16px (use the favicon drawing below 20px). Never rotate, outline, or colour the wire anything but Bone or Ink. The dot is Signal on dark, Ink on paper, Beacon only for "needs you".

### 24px (paste verbatim)

```html
<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="#F1EEE6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3" fill="#F1EEE6"/></svg>
```

Paper version: replace both colours with `#141311`.

### 18px menu bar, idle (template: monochrome)

```html
<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.8 4.6L9 14.8L13.23 7.85" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15.2" cy="4.6" r="1.9" fill="currentColor"/></svg>
```

### 18px menu bar, needs you

The dot grows slightly and turns Beacon. Ship as a non-template image (`#B8A4FF` on dark bars, `#5B3FC4` on light bars).

```html
<svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path d="M2.8 4.6L9 14.8L13.23 7.85" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15.2" cy="4.6" r="2.3" fill="#B8A4FF"/></svg>
```

### 16px inline (no tile)

```html
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 4L8 13L11.52 7.24" stroke="#F1EEE6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="13.5" cy="4" r="1.8" fill="#F1EEE6"/></svg>
```

### Favicon (16 and 32; tile)

```html
<svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#161513"/><path d="M8 10L15.5 22.5L19.81 15.31" stroke="#F1EEE6" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23" cy="10" r="3" fill="#F1EEE6"/></svg>
```

### App icon (1024; also use for 64+)

```html
<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" aria-hidden="true"><rect width="1024" height="1024" rx="230" fill="#161513"/><rect x="2" y="2" width="1020" height="1020" rx="228" stroke="#F1EEE6" stroke-opacity="0.08" stroke-width="4"/><path d="M230 3H794" stroke="#F1EEE6" stroke-opacity="0.2" stroke-width="3"/><g transform="translate(512 512) scale(25) translate(-12.55 -11.95)"><path d="M3.5 5.5L12 19.5L17.96 9.69" stroke="#F1EEE6" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20.5" cy="5.5" r="2.3" fill="#F1EEE6"/></g></svg>
```

### Wordmark "vyre" (monoline, drawn in the mark's wire; always lowercase)

Set height; width follows (ratio 62:26). At 40px tall it is 95px wide.

```html
<svg width="95" height="40" viewBox="-2 3 62 26" fill="none" role="img" aria-label="vyre"><path d="M0 6L6 20L12 6M16 6L22 20M28 6L19.4 26M33 6V20M33 13Q33 6 40 6M43 13H57A7 7 0 1 0 55.36 17.5" stroke="#F1EEE6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
```

### Lockups

`[mark 36] 16px gap [wordmark h40] 16px gap [1px x 28px rule #3A3733] 16px gap [MONO 16/20 500 UPPERCASE +0.18em #B3AEA4: AGENT | PLATFORM | AI]`

In nav bars: mark 20 + wordmark h22, no product label.

## Voice

Short, plain, first person only when Vyre is reporting what it did. Name the fact, then stop. No "unleash", "supercharge", "AI-powered", "seamless", no exclamation marks.

- Your agent has its own computer. Watch it work, or take the wheel.
- From your notes in March. No model was used. *(Recall)*
- This deletes 214 files. I stopped before running it. *(Beacon)*
- You have control. Hand it back when you're done. *(Glass take-over)*
- Only your tailnet can open this address.
- Install: `npm install -g vyre`. One command, shown alone, never behind OS tabs.
