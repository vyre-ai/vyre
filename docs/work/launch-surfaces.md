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
- NEW PRIORITY (the user's decision, 28 Sep, HANDOFF.md "Vyre anywhere"): onboarding's server
  choice becomes "Where should Vyre live?" — Solo (this computer, ~2 min, no Tailscale) /
  Another computer I have (Mac mini or Linux box) / A cloud server. Plus a polished "Move to
  server" flow in Settings, the SAME flow as onboarding's "I already have a server, connect it",
  with progress, what's moving, undo, and a "your laptop is now a device" celebration. Tailscale
  only appears once a second device or server joins. launch owns this UI; agree contracts with
  anywhere (the role choice, ADR 0039), federation (the move engine) and tailnet (the join flow).
  Also needed: a local one-command install for Solo (npm or script), agreed with anywhere. See
  "Where should Vyre live?" below.

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

## Where should Vyre live? (0.1.1, new priority)

Researched before proposing anything:

- Today's step 2 ("Pair this device with the server", `docs/design/onboarding-v2.md`) is
  pairing-only: it assumes a server already exists or is about to via Tailscale, and jumps
  straight to `tailscale`/`name`. There is no role choice screen and no Solo path anywhere in
  `deck/onboard/onboard.js`'s `STEPS`, and no Settings entry for "move to a server" exists in
  `core/onboard/` or the deck's settings surfaces.
- ADR 0038 ("Linux only" for the server) is superseded by ADR 0039 per HANDOFF.md; 0039 does not
  exist yet in this worktree (`docs/adr/0039*` absent), so the role/OS split is not yet written
  down anywhere I can build against.
- `docs/design/onboarding-v2.md` "One onboarding for every device" (step 2's existing-server
  detection) is the closest existing design to reuse for Move-to-server: same "add this device"
  shape, run from Settings instead of first boot.

Proposed UI (draft, pending the three teams below):

- Replace step 2's cold jump into pairing with a role choice screen, three cards: **Solo** (this
  computer, about 2 minutes, no Tailscale row shown at all), **Another computer I have** (Mac
  mini or Linux box), **A cloud server**. Solo confirms locally and skips straight to step 3;
  the other two flow into today's `tailscale`/`name` screens, unchanged, which is where Tailscale
  first appears.
- Settings gets a "Move to server" entry that runs the exact same engine as onboarding's
  "I already have a server, connect it" path (same tool calls, same progress UI), reachable at
  any time post-onboarding: a plan screen (what moves: projects, memory, vault, sessions, with
  sizes), live per-category progress (reusing `progressRow`), an undo action while the move is
  in flight or just after, and a closing screen naming the laptop as a device now ("This Mac is
  now a device. Your server is <name>.").
- Local one-command install for Solo: needs an agreed script/npm path from anywhere; today's
  `scripts/install-box.sh` is server-shaped (Tailscale, naming) and wrong for a Solo laptop.

Needed from others before building the state machine (asked, see Needs from others): anywhere's
role-choice tool shape and ADR 0039 text, federation's move-plan/move-start/move-status/undo tool
shapes (proposed names in the ask), and tailnet's confirmation that its join step truly never
renders for Solo. Look/copy for the three role cards can start now; the real engine wiring waits.

Built (client-only, wip b4df8f14): a new step `live` ("Where should Vyre live?") in
`deck/onboard/onboard.js`'s `STEPS`, between `you` and `tailscale`. Three cards (Solo / another
computer I have / a cloud server); Solo marks `tailscale` and `name` skipped and jumps straight to
`claude`, the other two fall through to today's pairing screens unchanged. `state.live` is
client-only until anywhere's tool lands, same degrade-gracefully shape as the `computers` step.
Named the step id `live`, not `role`, to keep it distinct from `core/config`'s existing
`role: "box"|"local"` field, which this choice will likely end up driving once anywhere's contract
exists (Solo -> `local`, the other two -> `box`, is my read, not confirmed). `test/onboard-page.test.js`
updated for the new hash; server-side `test/onboard.test.js` unaffected (15/15).

Settings placement for "Move to server", found while reading `deck/views/settings.js`: the
existing "Your devices" section (`drawDevices`, its `foot(toOnboard("devices", "Add a device"))`)
is the natural spot — a `role === "local"` box already has no peers to show there, so a "Move to
server" button belongs right next to "Add a device", not a new top-level Settings section. Not
built yet: waiting on federation's move-engine shapes before writing real UI, per Needs from
others.

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
- "Pair with a code" gated on `onboard.status.can.relayJoin` (the lead's ask, 28 Sep): new
  `deck/js/join-caps.js` (`canRelayJoin`, pure, false or missing both read false, never a platform
  guess). The live step now shows the tailnet-name field alone with the reason as one muted line
  when it's false, and only offers the code-pairing choice when it's true.
  `deck/fixtures/onboard.json`'s `onboard.status` gained the real `can` block (false, today's
  Mac case); `deck/fixtures/onboard-relay-true.json` added for the unit test's true case (not
  wired into the live fixture loader, which is one file per module). Tests:
  `deck/js/join-caps.test.js` (5/5, both fixture cases plus missing/null/non-bool), run on
  testbox; `test/onboard.test.js` re-run clean after (15/15). Sent to reviewer-2 with 68c2333f.
- reviewer-2's follow-up: no committed test actually drove `relay.join`'s `presence:"asked"`
  round trip — the prior onboard-page.test.js click-through only ever hit the fixture fallback
  (relay.join isn't a real tool, so a "missing" answer short-circuits before presence enters
  into it). Added `deck/js/api.test.js` tests for the "asked" sequence itself (passkey only once
  the box actually says presence_required; one round trip, no passkey, for a box that never
  asks; the same `{url, becomeDevice}` body both times) — 2 new, 13/13 in that file on testbox.
  Rewrote `test/onboard-page.test.js`'s device/relay test: it used to click a
  `?fixtures=1`-only radio as if live; now that the option is really gated and the real
  `onboard.status` has no `can` field yet, it correctly never shows in a real flow, so the test
  asserts exactly that (no radio, tailnet-name field alone, "Connect" not "Pair") — 4/4 in that
  file on testbox with `CHROME_BIN=/usr/local/bin/vyre-chrome` (headless, testbox's Playwright
  Chromium; the RULES `CHROME_BIN` default is a Mac path and testbox has no Chrome install).

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

- Applied memory-iq's two follow-ups: the ask box calls `memory.ask` (not `memory.answer`,
  which can't see freshly-imported sessions), handling `abstained`/`known`/`limited`/`sources`;
  the Choose screen reads real `import.plan` pace estimates and `import.scan`'s
  `claude_keeps_days` instead of placeholder copy; Discover now notes `left_out` counts.
  `core/onboard/loopback.js`'s allowlist swapped accordingly.
- `test/journey.test.js`: e2e confirmed the failure was a real, unrelated Mac-only bug (a caller
  check leaving vyred's socket blocking on a large answer), already fixed on `work/e2e-peerfix`
  and heading into rc.2. Not mine, no action needed.
- tailnet is being revived (the lead, 29 Sep) to work on Tailscale install/onboarding
  simplicity. Messaged it directly (not waiting) about steps 1-2 and `install-box.sh`; no reply
  yet.
- Landing page: the "Make it yours" section now tells the module story (Capsule/Glass/memory/
  vault as pieces, `vyre module new`), on top of the earlier terminology pass.
- Three more onboarding steps: `secrets` and `drive` stubbed ("Coming soon" cards); `computers`
  ("Agent computers": Off/Browser only/Browser + desktops) fully built, server sizes as
  placeholders pending glass-live's `docs/design/agent-browsers.md` and e2e's measurements.
  `docs/design/onboarding-v2.md` now documents ten steps; the client `STEPS` array still has
  nine (noted as unreconciled).

Resumed after the restart (28 Sep), reading RULES.md/HANDOFF.md fresh:

- Merged `main` (docker-api hotfix 57dc12c3, safe-git gpg fix 4fd286d7) into work/launch;
  CHANGELOG.md's additive conflict resolved by keeping both sections (e5514e46).
- Committed the memory-iq plan-share wording (no dollars) that was sitting dirty in
  `deck/onboard/onboard.js`/`deck/fixtures/import.json` (5bd97360): Fast/Gentle now read
  "uses more of your Claude plan" / "barely touches your plan", `import.json`'s `usd` field
  dropped.
  Confirmed the STEPS-array reconciliation noted above as still-open is actually done: the
  array now has 11 entries matching onboarding-v2.md's 10-step table exactly (two client
  screens for step 2, `capsule` split out as step 10), landed in an earlier commit
  (8dc07268) before this restart, this doc just hadn't caught up.
- Vyre Drive step (`drive`) rebuilt from the bare "Coming soon" line into an honest preview of
  federation's decided design (docs/design/drive-onboarding.md e69a544a): a sample folder
  picker, "Files on demand" default vs. a disabled "Server only" alternative, per-folder agent
  access noted, a disabled receive-files toggle, and the "watch it appear on your other device"
  line named as the payoff once devices pair and phone/Capsule land (ac2407a1, later fixed for
  reviewer-2's em-dash HOLD). Still inert: no onboard.* tool for any of it is allowlisted in
  core/onboard/loopback.js yet.
- rc.2 blocker (onboard.test.js:265, ts.net vs vyre.run): checked out work/integrator-rc into
  ../vyre-launch-rc2fix as work/launch-rc2fix to look. Root cause was core/names/index.js's
  hasToken() reading the mixed-case `CLOUDFLARE_vyre_token` instead of `CLOUDFLARE_VYRE_TOKEN`
  (all caps, what the docs/example env/the test actually use), so a zone token was never read.
  e2e had already found and fixed this on work/e2e-rcfix (a5eff01f), verified 120/120; dropped
  work/launch-rc2fix rather than duplicate it with a second sha, per the lead. Not launch's bug
  (core/onboard, core/names), and not the via() caching I first suspected.
- install-box.sh, per the lead (29 Sep): fixed a real, previously undetected shellcheck SC1087
  bug (pick_look()'s escape-code vars and step()'s counter, `$var[...` read as an array index;
  the "shellcheck is clean when available" test in core/names/system.test.js had silently never
  run anywhere shellcheck was installed until I installed it on testbox to check this branch),
  and added the asked-for "friendly wait line" (wait_line(), picked by pid) shown once before
  Docker's own curl|sh install, the one real silent gap. 5b6c17e9, tested 38/38 on testbox.
- Landing page screenshots for the lead to show the user (desktop 1440, phone 390): a real
  tooling gotcha cost most of this task's time. `vyre-chrome --window-size=390,...` silently
  clamps to a 500px minimum in this Chromium build (confirmed empirically: 499 requested reads
  as innerWidth 500, 501 reads correctly) while `--screenshot` still writes a 390-wide PNG, i.e.
  a crop of a page laid out for 500px, not a render at 390px. That looked exactly like a real
  mobile overflow bug (GitHub/Install clipped in the nav, hero paragraph text cut mid-word) until
  a proper CDP `Emulation.setDeviceMetricsOverride({width:390, mobile:true})` screenshot (see
  the scratch script written for this, not committed) showed the page is actually fine at true
  390px: nothing wraps or clips. No site bug, no fix needed. Screenshots are local-only (not
  committed; the lead asked for paths, not files in the repo), teardown confirmed (no leftover
  chrome/http.server processes on testbox). Worth remembering: any future phone-width screenshot
  on this Chromium build needs CDP device-metrics override, not `--window-size` alone.
- Two real phone-screen findings from the lead's own look at those screenshots, both fixed and
  verified with a proper CDP mobile-emulation screenshot: the hero's Option-Space hint now reads
  "Tap to try the Capsule right here." under `(pointer: coarse), (max-width: 720px)` instead of a
  keyboard shortcut nobody on a touch device can press; the install command's Mac tab now leads
  with "This puts Vyre on your Mac as a device that pairs with your server (Linux only) over your
  tailnet.", since it previously never said the Mac pairs rather than serves.
- PUBLISHED (the user approved, the lead ran the actual deploy): vyre.run is live from `site/` at
  2d13e42a (this branch), Cloudflare Pages project vyre-site, deploy
  https://103488f4.vyre-site.pages.dev. The box files and install.sh in that deploy are built
  from `main` 4fd286d7, not this branch, so installers get reviewed main code; my install-box.sh
  polish (5b6c17e9, the shellcheck fix + wait_line()) reaches the live installer once it lands on
  main. Verified: https://vyre.run 200 with the new headline and the tap hint live,
  https://vyre.run/install.sh 200.

Built (Settings > Server, fixture-backed against `deck/fixtures/federation.json`): a new "Server"
section in `deck/views/settings.js` (`drawServer`, `drawAlreadyMoved`), reading
`docs/design/anywhere.md` (work/anywhere, 11328815) for the exact flow: point at a server (paste
a code), a dry-run plan (the four pieces from anywhere's table — projects, memory, vault,
sessions — each with a count and size), "Start moving" while the source stays live, live
per-piece progress (polled every 5 s while the panel is open, same cadence as onboard's history
step), Undo, a confirm step before the flip ("Confirm: make this a device", separate from
starting the copy, per anywhere.md step 3), the "this computer is now a device" line, and "Free
up space on this laptop" gated 24 hours (anywhere.md's forget guard) with counts, never automatic.
Tool names (`federation.role.status`, `federation.move.plan/start/status/confirm/undo/forget`)
are launch's proposal, not yet confirmed by federation (asked). Only Solo/Server -> Device is
built; "Move off this server" (the reverse direction anywhere.md also names) is not, see Next.
Smoke-tested for real on testbox (a throwaway CDP script against `deck/test/native-bar/world.js`,
not committed): point-at-a-server -> plan showing all four pieces -> start -> live progress rows,
zero console/runtime errors, then torn down. No screenshot pass yet (app-design hasn't seen this
panel), and the plan/start/confirm/undo/forget tools all still answer from fixtures only.

Also reconciled the `live` onboarding step's copy with anywhere.md, which explicitly claims
ownership of "the three choices and their copy": h1 is now "How will Vyre run?", options are
"Just on this computer" / "This computer stays on for me, and I'll use other devices too" / "I
already have a Vyre server", and the internal values are config.role's real three
(`"solo"|"server"|"device"`), not this file's earlier guess (`"solo"|"device"|"cloud"`). Behavior
unchanged: Solo skips Tailscale/name; Server and Device both still fall through to today's
pairing screens, since anywhere.md's own "point at a server" entry for Device isn't wired into
onboarding yet (it exists now only in the new Settings panel above) — a candidate to unify later,
noted below rather than built twice under time pressure.

Fixed (the lead, after anywhere's answer): the field is `config.machine` (additive, ADR 0039),
not `config.role` (unchanged, stays box/local). Unified per the lead's explicit instruction — Move
to server is the SAME flow in onboarding and later: the `live` step no longer falls through to
the old tailscale/name screens for any choice. Solo and Server both call `onboard.machine{action:
"set", machine}` (Server surfaces `service.warning`, doesn't block on it) and skip tailscale/name
outright; Device shows an inline "Setup code or address" field and calls `onboard.join{action:
"verify"}` (tailnet's tool, also not shipped) instead of the old screens. Both tools are fixture-
backed in `deck/fixtures/onboard.json`, not shipped yet (anywhere: within the day; tailnet: not
started). Settings > Server's `drawServer` now reads `onboard.status`'s `machine` field (same
tool the onboarding step already calls) instead of an invented `federation.role.status`; only the
move-engine (`federation.move.*`, unrelated to config.machine) is still federation's own proposal.
Added the solo-path page test reviewer-2 and the lead flagged as missing (asserts Tailscale and
the address step are skipped, and the page lands on Claude sign-in), and fixed the existing
device-path test for the new behavior (lands on `#claude` now, not `#tailscale`; asserts both old
steps are skipped there too). Testbox verification pending the integrator's rc.2 freeze (20 min,
the lead, 29 Sep) — no Chrome runs from launch until it lifts; syntax-checked locally in the
meantime (`node --check` on every touched file, fixture JSON validated).

Found while doing this, not mine to fix: the landing page's Mac install tab still says "pairs
with your server (Linux only)" (ADR 0038 wording), which ADR 0039 supersedes now that a Mac can
be Solo or Server too. Flagged to site-copy and the lead rather than touched, since that page is
mid-rewrite by site-copy right now.

Extracted (the lead + reviewer-2, "pull it into a testable module like Drive did, don't wait for
federation"): `deck/js/server-rows.js`, pure functions (`fmtBytes`, `pieceLabel`, `pieceLine`,
`totalBytes`, `pieceState`, `readyToConfirm`, `destinationName`, `forgetGate`), the same shape as
`drive-rows.js`. `drawServer`/`drawAlreadyMoved` in `settings.js` now call these instead of inline
duplicates. Committed `deck/test/settings-server.test.js`, 6 tests, checked against the real
fixture data (`deck/fixtures/federation.json`'s move.plan/move.status/move.confirm,
`deck/fixtures/onboard.json`'s status/machine) per the lead's "test it against the fixtures", not
synthetic literals. Runs with plain `node --test`, no daemon or Chrome needed: 6/6 locally
alongside `settings-drive.test.js`'s existing 4/4.

Read tailnet's real, shipped `core/join` (work/tailnet, af604cf8, not on main yet) to wire the
Device path against something real instead of my earlier guess, and found a genuine mismatch:
`join.verify` takes an optional `node` id and forwards to `link.health` — a reachability check for
a device that already paired, not something that accepts a "setup code" to start one. It's also
box-role only, the same gap tailnet flagged for "a phone joins a Solo Mac": a fresh device
choosing "I already have a server" is role solo/local at that point, so `join.*` never even loads
on its own daemon.

tailnet then dropped that separate module and folded it back into `onboard.join` directly (same
shape convention as onboard.tailscale/claude/name): `{action:"status"|"tailscale"|"relay"|
"verify", step?, node?, becomeDevice?}`. Their design call: `verify`'s machine-flip only fires
with `becomeDevice: true`, since the same action is called from both sides of a join and only the
connecting device should ever demote itself. Updated the `live` step's Device branch to call the
real name with `becomeDevice: true` and moved the fixture back into `deck/fixtures/onboard.json`.
The underlying mismatch is unchanged and still open: `node` expects a device/node id, not the
setup code this screen's input actually collects, and the box-role gating question is still with
tailnet. Still degrades gracefully (a missing tool never blocks Continue), so nothing breaks, just
isn't truly wired yet.

anywhere shipped the real `onboard.machine` (sha 73d03d39): `{machine:"solo"|"server"} ->
{machine, service}`, no `action` wrapper (dropped from my earlier guess). `service` always comes
back `null` for now (the launchd/keep-awake installer isn't built), so nothing here reads
`service.warning` anymore — removed that dead branch rather than leave UI logic that assumes a
field anywhere explicitly said to treat as always-null. Fixture and the committed test both
updated to match (`service: null`, not `service.installed`).

Screenshot pass from app-design (ce9c4c5f) landed 5 ranked findings; built all five: the whole
move wizard now sits in its own card (`.set-server-card`: 1px `--rule` border, radius 12, per
`docs/design/system/components/card.md`), separate from the plain "This computer" status row
above it (#1). The
vault piece on the plan screen gets a lock glyph and anywhere.md's own encryption line, since
that promise was otherwise invisible (#2). `.set-meter` is a real 6px track+fill now, not a
hairline (#3). The live progress rows use the shared status-mark vocabulary (`statusMark` from
`deck/js/status-mark.js`: a running mark with the percent, a hollow done dot) instead of plain
"Waiting"/"Done" words — a not-yet-started piece keeps plain text since that model has no mark
for "not started", only running/done/needs/failed/unread (#4). The onboarding radio's selected
fill is `--focus` (lime) now, not `--text`, matching every other checked/selected state in the
system (#5). Not re-screenshotted yet; asked app-design for a second pass.

Fixed reviewer-2's caught bug (a real one, ahead-reviewed from git before I'd even sent shas):
the Device branch checked only `j.error`, never whether `onboard.join` actually said the server
was reachable, so a wrong code proceeded to Claude sign-in exactly like a right one. The real
tool's `verify` forwards to `link.health`, whose actual field is `online` (checked in
`core/link/health.js`), not `ok`/`reachable` as my earlier fixture guessed; now checks
`j.data.online === false` and shows the error (`why`, or a fallback line) instead of proceeding.
Added a real regression test (`test/onboard-page.test.js`, "Device with a wrong code..."),
driven through `?fixtures=1` since no real `onboard.join` exists yet to answer this for real —
which is how the `core/onboard/loopback.js` gap above (Changed contracts) was found: the test
failed with "the page never showed the name field" until that fix landed, then failed differently
("never showed an error line") until the URL-construction bug (query params before the `#`
fragment, not after) was also fixed. Both are real bugs this test caught, not the one it was
written for. Verified together on testbox: 36/36 across onboard-page/onboard/boundaries/
hygiene/settings-server/settings-drive.

~~Get app-design's second pass~~ done: all five confirmed fixed, running the real flow again, no
new findings.

Rebuilt the Device path per tailnet's actual, detailed answer (there is no single "setup code"):
two real mechanisms, not one placeholder field.
- **Same Tailscale network** (built): the "live" step now collects the server's tailnet name,
  then routes through the existing `tailscale` screen (which Device now runs, unlike Solo/Server
  — a device joining IS "a second device joining", the case that screen was always meant for;
  only "name", reserving this machine's own address, never applies to a device). Once signed in,
  "Continue" calls `onboard.join{action:"verify", node, becomeDevice:true}` there instead of the
  screen's normal `s.next()`, showing the real error on a wrong node (reviewer-2's bug, now
  actually reachable by a test: fake Tailscale already `BackendState: "Running"`, no login click
  to simulate) or proceeding to Claude sign-in with `tailscale` marked done and `name` skipped.
- **Pair with a code** (now built too, tailnet shipped the real shape same day): one call,
  `relay.join{url, becomeDevice:true}` — no separate verify step, since a successful pairing
  already proves reachability. `via` is a second, inner radiogroup under "device" (same
  Tailscale network / pair with a code), each with its own field; the footer's label changes to
  match ("Connect" vs "Pair") so the button says what it actually does. Fixture-backed
  (`deck/fixtures/relay.json`); the real tool isn't on main yet.
Rewrote the regression test accordingly (connects a fake Tailscale, verifies a wrong node fails
with an error and stays put, then Back-and-fix proceeds for real), and added one for the relay
path. Verified on testbox: onboard-page 4/4, full targeted set 40/40.

Also closed reviewer-2's race-window finding on the Server panel (26ba1830): `watch()` attached
its `move.*` listener only after `move.status`'s baseline call resolved, so an event landing
during that round trip (a fast-finishing piece, say) was lost for good, with no poll left to
self-correct. Now attaches the listener first, buffers anything that arrives before the baseline
is in, replays the buffer onto it, then switches to live — pulled the merge logic itself into
`server-rows.js`'s `mergeEvent` (pure, unit-tested: one event applied, and buffered-then-replayed
producing the same result as applied live) so this DOM-adjacent flow has a real testable seam,
same ask reviewer-2 made about the rest of this panel earlier.

The lead: relay.join is reviewer-cleared (93754fa2) and no longer hypothetical. Wired
`attempt("relay.join", {url, becomeDevice:true}, {presence:"asked"})` (was a bare `attempt`),
since the real tool's own presence summary (core/relay/index.js, reviewer's MEDIUM on 93754fa2,
fixed 6cd9c02d) is where the box name, relay host and key fingerprint actually show — a passkey
confirmation the person sees, not something this screen renders itself. Confirmed safe against
the fixture path (fixtures answer before the tool is even found "missing", so presence never
enters the fixture flow; the request stayed the same shape in all 4 onboard-page tests, still
40/40 on testbox).

**Blocked**, asked directly: "keep the option hidden on a Mac until vyre-core, shown on Linux and
Windows" has no client-side signal to build against. Checked `onboard.status`, `onboard.tailscale`
detect, and tailnet's own `tailnetPeers()` parsing (`core/onboard/index.js`, which reads OS only
for *other* peers via `tailscale status --json`'s `Peer` map, never `Self`, and needs Tailscale
already running either way — this device may not be, since avoiding Tailscale is the whole point
of the relay path). Nothing named "vyre-core" exists yet in the codebase (grepped). Not building a
guess at this; asked the lead/anywhere what to check. The option shows unconditionally for now.

## Next

- Get the vyre-core platform signal (see above) and gate the relay option on it once it exists.
- Build "Move off this server" (Device -> Solo, the reverse direction anywhere.md names) in
  Settings > Server; only the forward direction is built.
- Wire `service.warning` into the Server step once anywhere's launchd installer actually
  populates it (anywhere: "will ping you the moment that lands").
- reviewer-2's non-blocking note (f7c311bf): `verifyDevice` (and the pre-existing "server"
  branch) has no cancelled/alive guard around its in-flight `attempt()` calls the way Settings'
  `drawServer` does (`ctx.alive()` after every await) — a Back click mid-verify that later
  resolves successfully would still redirect to Claude sign-in. Systemic to onboard.js generally
  (its `cleanup[]` covers timers/listeners, not in-flight async calls), not something to fix in
  one screen alone; worth its own pass across the file.
- Screenshot-verify the import step against fixtures once there is time for the temp-vyred setup.
- Step-shell's final summary, per the lead (build both, 29 Sep): showEnding()'s "What's next"
  ticks gained a fourth row for the Agent computers choice (9d4103f0); a per-step celebration
  landed (a 480ms CSS pop on the just-completed step's checkmark/dot, reduced-motion-gated,
  non-blocking); and a warm one-line note for still-stub steps ("Secrets, accounts and Drive are
  ready when you are: Settings.", correctly cased/pluralized for whichever subset remain). The
  ending screen's existing easter egg (endMark()'s burst) was already there from ADR 0008, left
  untouched.
- Coordinate with tailnet once it replies about steps 1-2 and install-box.sh.
- Once vault/federation send real tool shapes for secrets/drive, replace the inert previews with
  working forms, and drop that id from showEnding()'s stub-steps dict so the warm line stops
  naming it.

## Needs from others

- ~~anywhere: the role-choice tool shape~~ answered and REAL now (sha 73d03d39, work/anywhere):
  `onboard.machine{machine:"solo"|"server"} -> {machine, service}`, `service` always `null` for
  now (their launchd installer is next on their list; will ping when it's real). ~~Solo one-
  command install~~ answered: `npm install -g https://vyre.run/box/vyre.tgz` + `vyre up`, no new
  script; pointed at it in the onboarding comments, not yet in any shipped copy.
- ~~tailnet: onboard.join shape~~ ~~the Device-path mismatch~~ both answered in full and both
  built: `onboard.join{action:"status"|"tailscale"|"relay"|"verify", step?, node?, becomeDevice?}`
  for same-Tailscale (real-shaped, not merged to main yet), `relay.join{url, becomeDevice}` for
  pair-with-a-code (also real-shaped, also not merged yet — tailnet built it the same day once
  asked). ~~confirm the join flow never renders on the Solo path~~ confirmed. Still open:
  names.discover's client-side peer-scan is unbuilt and, per tailnet, not gated on anything of
  theirs now; worth deciding whether it's still needed given onboard.join's own `status` action,
  rather than building both.
- ~~federation: move-engine tool shapes~~ answered and confirmed (docs/work/federation.md):
  `move.plan{destination}`, `move.start{planId}`, `move.status{moveId}` ({stage, pieces:
  {bytes,of,done,error}}), `move.confirm{moveId}`, `move.cancel{moveId}` (the Undo, full stop
  before confirm; no undo after — that's the separate 24h+ "free up space" flow), and events
  (move.progress/move.piece.done/move.failed/move.confirmed) for live progress instead of
  polling. Wired the whole panel to this shape and switched from a 5 s poll to the event stream
  (deck/js/api.js's `on()`), since Settings has the real stream, unlike onboarding's loopback.
  Asked federation one open question: no explicit "ready" event exists, so the Deck infers it
  itself (`allReady`, every named piece done with no error) — asked whether that's a safe
  inference or whether there's a checksum/verify race it should poll `move.status` once more to
  cover instead. Not yet answered.
- app-design: a second pass on the Server panel's five fixes (card, vault lock note, real
  progress bar, status-mark vocabulary, lime radio fill), landed after their first screenshot
  pass but not yet re-reviewed.
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
- `core/onboard/loopback.js`'s `assetPath` (not launch's file; smallest change through the
  contract, per RULES): added `fixtures` to the static-path whitelist regex. Found while writing
  a real regression test for reviewer-2's caught bug (see Doing): the onboarding page's own
  `?fixtures=1` mechanism (deck/js/api.js) 403'd on every `/fixtures/*.json` fetch, since that
  path was never in the whitelist, silently degrading to "missing tool" instead of ever serving a
  fixture. Verified additive and safe: `/fixtures/onboard.json` now 200s, a `..` traversal
  attempt still 403s (the existing `!p.includes("..")` guard is unaffected, checked directly).
  No existing test named this path. Flagged to whoever owns onboard's loopback/sessions, since
  it's the first thing that's actually exercised onboarding-with-fixtures end to end.
