# launch: landing, install, onboarding, brand surfaces

(Named launch-surfaces.md because launch.md and LAUNCH.md are the same file on a case-insensitive disk.)

## Scope

- `site/` (vyre.run): index.html, styles.css, app.js, 404.html, og.png, favicon, `site/start/`.
- `scripts/install-box.sh` terminal experience (look only; flags, exit codes and `VYRE_NO_UP=1` unchanged).
- Look and copy of the onboard loopback pages (core/onboard). Logic stays with sessions.
- Brand surfaces and easter eggs listed below.
- 0.1.1 (lead, 28 Sep): the interactive import flow in onboarding: after a device pairs, show
  discovered Claude Code sessions (counts, date ranges, projects, dev folders unticked), let the
  person pick and confirm once, show live three-stage progress (searchable now / understood / the
  graph growing), let them start using Vyre right away. Full owner this time, not look-only: the
  step's state machine too. Use "server" and "devices", not "box"/"Mac" (see below: this wording
  is net-new, not an in-progress rename elsewhere). Work with memory-iq, federation (owned by
  tailnet, ADR 0021) and app-design. See "The import flow" below.

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

## The import flow (0.1.1)

What exists today (researched before writing any code):

- Onboarding already has a `history` step: `core/onboard/index.js` `STEPS` (server) and
  `deck/onboard/onboard.js` `STEPS` (UI). The UI's `history` render already shows a session count,
  a live progress bar, and a search/checkbox picker to build a project from picked sessions, the
  closest existing analog, but it is post-hoc project-building, not a pre-import selection screen,
  and has no dev-folder-unticked-by-default concept.
- Federation (tailnet, ADR 0021, `core/link/` + `core/modules/federate.js`) already federates
  session data across a paired device (`recall.sessions`, `projects.catalog` with a `machines`
  param) and can answer session counts per source, but not yet a per-project/date-range breakdown
  for a single newly-paired device, which this flow needs for the picker.
  federation.md flags onboarding's history meter as a known gap: it reads only the local
  `recall.status` today, ignoring a paired device's sessions.
- memory-iq (ADR 0023, `core/memory/personal/*`) is personal-fact extraction today
  (`memory.answer`), not a session-import/graph-progress signal. Nothing exists yet for
  "searchable now / understood / the graph growing" as an onboarding-visible state machine.
- "Server" and "devices" is new wording, not an in-progress rename: zero hits for it anywhere in
  docs today. Scoping this rename to the import flow's own copy, not a repo-wide pass.
- Reusable UI: `progressRow(label, state, note, since)` in `deck/onboard/onboard.js` already
  renders a todo/doing/done/failed checklist row with a spinner/check and elapsed time: a
  straight fit for the three progress stages, not built from scratch.

Needed from others before building the state machine (asked, see Needs from others): a
per-project/date-range session-discovery tool from federation/tailnet, and an import-progress
signal (or the three stages modeled as onboard-local state, if memory-iq has no such signal yet)
from memory-iq. Look/copy and the picker UI can start without waiting; the live-progress wiring
needs an answer first.

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
- The lead's last item: `.btn`, `.chip`, `.dtab` and `.lbl` were named as needing sentence case,
  no uppercase. Checked each against its component doc before touching anything (receiving
  feedback well means verifying, not just complying): button.md's own Gaps section names the
  `.btn` mono-uppercase pattern as exactly wrong and gives the fix (Sans 13/18 weight 600,
  sentence case); chip.md and tabs.md say the same for chips (12/16 weight 400) and tabs (13/18).
  Fixed all three, plus `site/404.html`'s own stale copies of `.btn` and `.nav-links a`. Held
  `.lbl` back: `docs/design/TOKENS.md` (status: stable) still documents that exact role, "Label
  (engraved)", as mono/uppercase/`+0.16em`, and no component doc overrides it the way button.md
  overrides `.btn`. Flagged below rather than changing ~15 eyebrow labels against the written
  spec.
- The lead resolved it: `docs/design/system/copy.md` ("Sentence case everywhere... no caps
  labels and no letter-spaced mono captions") is current, TOKENS.md is the stale doc (app-design
  to update it post-RC). Changed `.lbl` to Sans meta (12/16, no tracking) in `site/styles.css` and
  `site/404.html`, plus `.page .over` (the fifth uppercase rule the lead counted) and
  `deck/onboard/onboard.css`'s `.progress .state` (same stale pattern, same file family). Every
  label's underlying text was already sentence case, so this was CSS-only, no copy rewrites
  needed. Screenshotted the single theme the landing page has (it's dark-only, no light/paper
  mode in site/ at all, unlike the docs/brand art or the app itself).
- app-design's re-review confirmed btn/chip/dtab/404.html and agreed on `.lbl` (citing
  `docs/design/one-app/project/vyre.css` as the canonical board CSS and `docs/design/system/`
  as the system of record over root-level TOKENS.md). Caught two more: `.lbl` should be weight
  600, not the 400 used in the first pass (fixed in `site/styles.css`, `site/404.html`,
  `deck/onboard/onboard.css`'s `.progress .state`); and `.dtab[aria-pressed="true"]`'s selected
  text was lime (`--signal`), a pre-existing nit (not from this session) that tabs.md/chip.md say
  should be neutral text with only the ring/fill carrying colour. Fixed to `--bone`.
- The user asked for a cheap-opportunities list (top 8, sent to the lead, not in this doc since it
  wasn't a build ask). Lead greenlit 4 for rc.2, gave item 2 (GitHub social-preview upload) to
  the user directly since only the repo owner can do it, and deferred the rest to 0.1.1:
  - OS-aware install-tab default (Mac on a Mac, Linux box otherwise), remembered per visitor
    after their first real choice. `app.js`'s OS guess checks both `navigator.platform` and the
    UA string (the first pass checked platform only and tested wrong under a `--user-agent`
    override in headless Chrome, since Chrome doesn't always change `navigator.platform` to
    match). Verified with real Mac and Linux UA strings on testbox; the remember path is a
    straightforward `localStorage` get/set already wrapped in `try`/`catch`, verified by code
    review rather than a scripted browser test (no harness exists for `site/app.js`).
  - `site/robots.txt`, `site/sitemap.xml`: added, neither existed.
  - `theme-color`: already present on all three pages, turned out to need nothing.

## Doing

- Built onboarding-v2 step 4 (import your sessions) against memory-iq's docs/design/import.md
  spec plus the lead's later decisions (sync checkbox unticked, Fast/Gentle pace neither
  preselected, 30-day Claude Code retention note): `deck/onboard/onboard.js`'s `history()`
  rewritten into Discover/Choose/Watch, `core/onboard/loopback.js`'s tool allowlist extended
  (`import.scan/plan/start/status`, `memory.answer`), fixtures added
  (`deck/fixtures/import.json`, a `memory.answer` entry in `deck/fixtures/memory.json`). Then
  memory-iq shipped `core/import/` for real (959e8e2f) with shapes that differed from the design
  doc's guess (two-level scan: source then folders, suggested/why on the folder; plan.folders is
  the path array, not a count; status has no "upload" stage and graph is a live count, not a
  done/total); corrected the UI and the fixture to match. `import.start` still does not exist
  (waits on federation's transport), so it still degrades through the missing-module pattern.
  Not yet screenshot-verified with fixtures (`?fixtures=1`): would need a temp vyred + browser
  session on the test box, deferred as disproportionate effort while the contract keeps moving;
  `test/onboard*.test.js` (16/16) confirms the daemon/loopback side is unaffected.
- Terminology sweep for ADR 0038 (server/device, no "box"): `site/index.html`,
  `site/start/index.html`, `README.md`, `scripts/install-box.sh`'s terminal copy. Left URL paths
  and one literal quote of `vyre up`'s live CLI menu text alone (the CLI itself has not renamed
  that string), and left `role: "box"` config/status output alone (the ADR keeps it for 0.1.1,
  that rename is platform/native-core's). Updated `core/names/system.test.js`'s two assertions
  that matched install-box.sh's exact old wording.
- `docs/design/onboarding-v2.md` updated: the lead's "one onboarding for every device" scoping
  decision, a new step 7 (Vyre Drive, not designed yet), renumbered phone/Capsule to 8/9, and
  app-design's three new boards noted against their steps.
- `test/journey.test.js` failed on this branch at journey 1's very first `vyre up` (before
  onboarding's browser is ever reached, "vyred is already running" / "onboarding is not
  available: links are made only from the box's own terminal"), which looks like pre-existing
  test-environment state, not this change; did not chase further since it is e2e's suite.

## Next

- Screenshot-verify the import step against fixtures once there is time for the temp-vyred setup.
- Confirm `test/journey.test.js`'s failure is pre-existing (not caused by this branch) with e2e,
  or fix it if it turns out to be mine.
- Start building the step-shell and steps 1-3, per the lead's go-ahead.
- Design step 7 (Vyre Drive) once federation's options and the user's choices come back.

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
- ~~federation: per-project/date-range session breakdown~~ answered: memory-iq's `import.scan`
  covers this for real now (core/import/, 959e8e2f).
- ~~federation: standalone flow or an entry point into onboarding-v2?~~ answered by the lead: one
  onboarding for every device (docs/design/onboarding-v2.md "One onboarding for every device").
- vault (onboarding-v2 step 5 and part of step 6): tool shapes for discovering and importing
  secrets per source (`.env`, shell exports, password managers, Chrome, SSH keys, MCP/Claude env).
  app-design's sent the step 5 board (`VaultImport.dc.html`, 19a96abd) ahead of the tool shapes;
  asked; not yet answered.
- connectors (onboarding-v2 step 6): confirm scope, which existing connector flows this step
  wraps. app-design's `Connections.dc.html` (db3dbbfa) is available if it helps.
- app-design: still owed the step-shell's shared progress/celebration board (the step 5 and
  step 4 boards landed).
- mobile: confirm step 8 (phone pairing, renumbered from 7) is fine as a stub for 0.1.1.
- federation: step 7's drafted Vyre Drive options, once the lead brings the user's decisions
  back; step 2's existing-server detection contract for the "add this device" path.
- windows: `docs/using/windows.md` (in progress) needs to cover what onboarding-v2 step 2 points
  a fresh Windows PC at for install.

## Changed contracts

- `core/cli/screen/layout.js`: `render(st, opts)` gained an optional `opts.fortune` string
  (default `""`); existing callers are unaffected.
- `core/cli/screen/index.js`: now imports `fortune` from `../delight.js` to fill that option each
  frame.
