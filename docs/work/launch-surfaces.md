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

## Doing

- /start page: exists (`site/start/`), not yet re-reviewed against Design A in this pass.
- Confirming the Capsule hotkey with capsule-pro before calling the landing demo final (asked;
  current copy says "Control twice").

## Next

- Screenshots: testbox load was 6.83 at last check (over the "under 6" bar), none taken yet.
  Retry once it drops, or hand off to app-design/e2e to verify visually on their own pass.
- GitHub social preview upload (file is done in docs/brand/; the lead/integrator uploads it).

## Needs from others

- lead: which of Vyre IQ, Capsule auto-answer, voice, "do" computer use and the settings hub are in the RC. Until answered, anything not on main shows "coming".
- capsule-pro: confirm the real Capsule hotkey (asked this session).
- sessions: pending onboard changes, if any.
- app-design: review of every visual, flagging in particular the 404 page and onboard step bar,
  built this session.
- e2e: rc-smoke on the finished sha.

## Changed contracts

- `core/cli/screen/layout.js`: `render(st, opts)` gained an optional `opts.fortune` string
  (default `""`); existing callers are unaffected.
- `core/cli/screen/index.js`: now imports `fortune` from `../delight.js` to fill that option each
  frame.
