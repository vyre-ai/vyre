# launch: landing, install, onboarding, brand surfaces

(Named launch-surfaces.md because launch.md and LAUNCH.md are the same file on a case-insensitive disk.)

## Scope

- `site/` (vyre.run): index.html, styles.css, app.js, 404.html, og.png, favicon, `site/start/`.
- `scripts/install-box.sh` terminal experience (look only; flags, exit codes and `VYRE_NO_UP=1` unchanged).
- Look and copy of the onboard loopback pages (core/onboard). Logic stays with sessions.
- Brand surfaces and easter eggs listed below.

## Surfaces

| Surface | Owner | Status |
|---|---|---|
| Landing page vyre.run | launch | doing |
| /start page | launch | todo |
| 404 page | launch | doing |
| favicon.svg, apple-touch-icon.png | launch | check against Lead mark |
| og.png (1200x630) | launch | doing |
| GitHub social preview (1280x640, file only; the owner uploads it) | launch | doing |
| README hero image | launch (file), docs (README text) | doing |
| install.sh terminal output | launch | doing |
| Onboard loopback pages | launch (look/copy), sessions (logic) | doing |
| `vyre` no args, `vyre --version` banner | polish-cli | asked |
| `vyre up` ending | polish-cli | asked |
| Release notes header | docs | spec to hand over |
| Docs site header | docs | spec to hand over |
| Deck first run | pwa | spec to hand over |
| Phone first run | mobile | spec to hand over |
| Capsule first run | capsule-pro | spec to hand over |

## Easter eggs (for the lead's list; keep quiet publicly)

All off for --json, CI, NO_COLOR, non-TTY and prefers-reduced-motion. No network, no sound, never on real data.

Filled in as each lands.

## Done

- Landing page vyre.run (`site/index.html`, `site/styles.css`): hero "Your best work, with a
  partner that never drops the thread.", Design A only (no gold; violet reserved for "needs
  you"), colours from `lib/theme/tokens.json`.
- 404 page: rebuilt self-contained, does not load `/styles.css`.
- favicon.svg, apple-touch-icon.png: checked byte-for-byte (favicon) and visually (touch icon)
  against the Lead mark in `docs/design/TOKENS.md`: match.
- install.sh terminal look, `deck/onboard` look/copy: done, tested (65 passing incl.
  `test/install-box-look.test.js`, `core/names/system.test.js`, `test/onboard*.test.js`).
- Fixed the `npm install -g vyre` bug: README.md only (install.sh and the landing page already
  had it right).
- `core/cli/delight.js` + `core/cli/commands/high-five.js`: the rare fortune line and the hidden
  `high-five` command, per polish-cli's agreed option A. Wired into the screen's title bar
  (`core/cli/screen/layout.js` render() gained an optional `fortune` string; `screen/index.js`
  computes it once per frame). Tests in `core/cli/delight.test.js`; full `core/cli` suite
  (consistency + boundaries + screen) still green.
- Brand assets in `docs/brand/`: og.png, social-preview.png, readme-hero(.png/-light.png), each
  with its source .html.

- /start page: re-reviewed on testbox (screenshot below), reads clean and matches Design A. No
  changes needed.
- Fixed a real bug found while screenshotting the landing page: the install tabs (Linux box /
  Mac / What it needs) showed all three panels at once and did not respond to clicks. `.ipanel`'s
  own `display: flex` beat the browser's default `[hidden]{display:none}`, and `app.js` never had
  a listener for `.itabs`. Fixed in both files, screenshot-verified fixed. See CHANGELOG.md and
  site/CHANGELOG.md.
- Screenshots taken on testbox once load dropped from 6.83 to ~1 (`vyre-chrome --headless=new`,
  own http.server on a scratch port, torn down after): landing (1440), landing (390 mobile), 404
  (1440), /start (1440). Confirmed against docs/design/TOKENS.md and the Design A boards; nothing
  else stood out at that pass (the gold finding below came from app-design's own review, after).
- capsule-pro confirmed the real hotkey: Option-Space by default, Control twice is an optional
  toggle (menu-bar mark, needs Input Monitoring). Fixed everywhere the old "Control twice only"
  copy showed: hero hint, feature list, settings preview, keycap icons, the demo's key listener,
  README.md, site/start/index.html, deck/onboard/onboard.js.
- app-design's review found two real problems, both fixed: gold (`--recall`) still styling the
  whole memory section though Design A retired it completely (redesigned as plain source chips
  and plain text, no fill, `1px solid var(--rule-strong)` border, matching the Og board's "From ·
  Q3 report · Harlow Legal · Tue" pattern), and `deck/onboard/onboard.css`'s `.dev-off`/`.need`
  using `var(--beacon-wash)`, a token never generated into deck/css/tokens.css (swapped for
  `var(--hover)`). Screenshot-verified the memory section and the hotkey copy on testbox.
- Received app-design's launch art (Og, Social, ReadmeHero, both themes, Design A, audited clean)
  and put it in place: `site/og.png` (dark, matches the page's `og:image` meta) and
  `docs/brand/{og-paper,social-preview,social-preview-paper,readme-hero,readme-hero-light}.png`.
  Renamed from the handoff's `Og.png`/etc to lowercase before copying in, since this Mac's
  filesystem is case-insensitive and a same-cased copy would have collided with the existing file.
- The lead caught one more retired token the app-design review missed: `--beacon-wash` was still
  live in `site/styles.css` itself (not just onboard.css), backing `.dest.do` (dead CSS, removed),
  `.held-chip` and `.ph-card`'s border. Violet is text-only now, everywhere: matches
  `core/config/palette.js` (`beacon-ink`/`beacon-dot`, no wash) and the "needs you" rule.
  `--beacon-wash` is gone from `:root` entirely. This round wasn't part of aa9da103; sha 342e02f5
  had already fixed the memory-section gold and the hotkey, so only this token needed a follow-up.
- Follow-up from the same review pass, both fixed: `.held-chip` had leftover badge styling
  (uppercase, letter-spacing) from when it had a fill; now sentence case, plain text. And the
  hero/demo keyboard hint rendered Option-Space as two chips instead of one chord (key-hint.md:
  modifiers first, no plus sign, one chip). app-design's nit, cheap enough to fix before the
  deadline rather than deferring.

## Doing

- Nothing in progress right now.

## Next

- Nothing blocking.

## Needs from others

- lead: which of Vyre IQ, Capsule auto-answer, voice, "do" computer use and the settings hub are in the RC. Until answered, anything not on main shows "coming".
- sessions: pending onboard changes, if any.
- app-design: a second pass on the memory-section redesign and the hotkey copy, since both
  changed after their last review.
- e2e: rc-smoke on the finished sha.
- integrator: docs/brand/*.html (launch's own standalone renders) are now superseded by
  app-design's docs/design/one-app/project/*.dc.html on work/app-design (registered in
  canvas.json, e95897c3). Left launch's .html sources as-is rather than trying to reconcile two
  branches; worth cleaning up docs/brand/ to point at or drop in favour of the canvas boards once
  both branches are merged.

## Changed contracts

- `core/cli/screen/layout.js`: `render(st, opts)` gained an optional `opts.fortune` string
  (default `""`); existing callers are unaffected.
- `core/cli/screen/index.js`: now imports `fortune` from `../delight.js` to fill that option each
  frame.
