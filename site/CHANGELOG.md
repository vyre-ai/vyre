# vyre.run changelog

Newest first. The landing page is a static site: `index.html`, `styles.css`, `app.js` and a few
assets, with no build step and no framework. Fonts load from Google Fonts; the one script is local.

## Unreleased

### Every word rewritten in plain English (2026-09-28)

- The user found the old copy odd and full of AI tells ("never drops the thread"). site-copy
  rewrote the landing page, /start, the 404 and the demo strings in `app.js` to stop-slop rules:
  concrete claims, short sentences, no metaphors, no em dashes, no triplets. New H1: "Run Claude
  Code on your own server." Layout and CSS unchanged. Diagnosis, options and scores:
  `docs/work/site-copy.md`.
- Claims cut back to what the docs say ships: the phone runs the Deck from the home screen (no
  native app yet); your address is your Tailscale name today (`<you>.vyre.run` is coming); Vyre
  needs a Linux server today (Mac-only is coming); Bash file changes are not on the safety list;
  vyre.run hosts the page and installer (the DNS name directory is not built). /start's pairing
  note now matches `docs/known-gaps.md`: approve a Mac from the Deck on your phone.
- `app.js`: a copy button now puts back its own aria-label after "Copied", where it used to
  overwrite every one with "Copy the install command".

### The module story, "Make it yours" (2026-09-28)

- The lead asked for the landing page's "Make it yours" section to tell the module/Lego story
  more fully, on top of the terminology pass already done. `h2` changed from "Open source, and
  built to be changed" to "Open source, and built from pieces"; the body now names the pieces
  (Capsule, Glass, memory, the vault) and says they only ever talk to each other through the same
  open door a person's own module would use. New feature line, "Build your own": `vyre module
  new` scaffolds a real one (tool, setting, Now card, tested in minutes): real per ADR 0033/
  `docs/work/platform.md` (`vyre module new/list/check` are P1, done), not overclaiming the P3
  `add`/`remove`/`update` verbs that aren't shipped yet.

### OS-aware install tab, robots.txt, sitemap.xml (2026-09-28)

- Cheap first-impression fixes the lead asked for: the install tabs (Linux box / Mac / What it
  needs) always defaulted to Linux box, so a Mac reader's first look at the page showed the wrong
  command. `app.js` now guesses from `navigator.userAgentData`/`navigator.platform`/
  `navigator.userAgent` (checked against both platform and the UA string, since a `--user-agent`
  override does not always change `navigator.platform`, which is how the first pass of this fix
  tested wrong under headless Chrome) and defaults to Mac there. Verified with `vyre-chrome
  --headless=new --user-agent=...` under both a Mac and a Linux UA string.
- Whichever tab a person actually clicks is remembered (`localStorage`, wrapped in `try`/`catch`
  so private browsing or a blocked store never breaks the page) and wins over the guess on a
  later visit. Verified by code review against the existing `navigator.clipboard` try/catch
  pattern already in this file, rather than a scripted two-navigation browser test (no test
  harness exists for `site/app.js`'s runtime and building one wasn't worth it for this).
- Added `site/robots.txt` and `site/sitemap.xml` (just `/` and `/start`; `/404` is excluded).
  Neither existed before. `theme-color` was already set on all three pages, so nothing to do there.

### .lbl's weight, and the selected tab's text colour (2026-09-27)

- app-design's re-review caught a detail the sentence-case pass got wrong: `.lbl` should be weight
  600, not 400 (their canonical board CSS, `docs/design/one-app/project/vyre.css`, has it exactly:
  `font-size:12px; weight:600; color:var(--label)`). Fixed in `site/styles.css`, `site/404.html`'s
  own copy, and `deck/onboard/onboard.css`'s `.progress .state` for the same reason it got the
  rest of that fix.
- Also fixed an unrelated pre-existing nit app-design flagged while reviewing: the selected
  Capsule state tab (`.dtab[aria-pressed="true"]`) coloured its own text lime (`--signal`). Both
  tabs.md (selected ink `--text`) and chip.md's filter-chip "On" state want the text neutral, only
  the ring/fill carrying the colour. Text is `--bone` now; the lime border and wash stay.

### The last of it: .lbl and .page .over, sentence case everywhere (2026-09-27)

- Held `.lbl` back last round on the strength of `docs/design/TOKENS.md` (status: stable), which
  still documented a mono/uppercase/`+0.16em` "Label (engraved)" role. The lead settled it:
  `docs/design/system/copy.md` ("Sentence case everywhere: titles, buttons, labels, menus. No
  caps labels and no letter-spaced mono captions") is the current rule, TOKENS.md is the stale
  one, and app-design will update it after the RC. Changed `.lbl` to the meta step in Sans (12/16,
  weight 400, no tracking), and `.page .over` (the Chrome mock's "Harlow County Court" overline,
  the fifth uppercase rule) to match. `site/404.html`'s own `.lbl` and
  `deck/onboard/onboard.css`'s `.progress .state` had the identical stale pattern; fixed both for
  the same reason. Every label's underlying text was already sentence case ("Sends to", "Open
  source · Apache 2.0 · Built on Claude Code", "Harlow County Court"), so this was CSS-only: no
  copy to rewrite.
- The landing page and 404 have no light/paper theme (dark only, no `prefers-color-scheme` or
  `data-theme` anywhere in either file), so "both themes" only applies to the docs/brand art, not
  this fix. Screenshotted the single dark theme on testbox instead.

### Buttons, chips and tabs: sentence case, off the old mono/uppercase pattern (2026-09-27)

- `.btn`, `.chip` and `.dtab` (the Capsule state tabs) were all still JetBrains Mono, uppercase,
  with wide letter-spacing: the pattern `docs/design/system/components/button.md`'s own Gaps
  section names outright ("Deck: `.btn` is JetBrains Mono 12, weight 500, upper case with letter
  spacing; use Instrument Sans 13/18 weight 600, sentence case"), and chip.md/tabs.md confirm the
  same for chips (12/16 weight 400) and tabs (13/18, selected weight 600). Underlying copy was
  already sentence case ("Install", "Copy", "Send", "Typing", "coming"), so only the CSS moved:
  Sans instead of Mono, no `text-transform`, no `letter-spacing`, updated sizes/weights per each
  component's spec. `site/404.html` had its own copies of `.btn` and `.nav-links a` with the same
  stale pattern (site/styles.css's own `.nav-links a` was already fixed); brought both in line.
- Left `.lbl` (the mono, uppercase, `+0.16em` "Label (engraved)" role: eyebrows like "OPEN SOURCE
  · APACHE 2.0", "02 MEMORY", "SENDS TO") alone. `docs/design/TOKENS.md` (status: stable) still
  documents that role as mono/uppercase/tracked, and unlike button/chip/tabs, no component doc
  says otherwise. Flagged to the lead rather than changing ~15 call sites against the current
  written spec.

### held-chip: sentence case, no badge tracking; the hotkey chip is one chord (2026-09-27)

- `.held-chip` ("Held for you") also had `text-transform: uppercase` and `letter-spacing: 0.14em`
  left over from when it was a filled badge. The lead asked for sentence case now that it's plain
  text next to a dot: dropped the mono font, the uppercase transform, the tracking and the now-
  unused padding/border-radius.
- The hero and demo-header keyboard hint rendered Option-Space as two separate chips (one for
  &#8997;, one for "Space"). key-hint.md is clear a chord is one chip, modifiers first, no plus
  sign (its own examples: "&#8984;K", "&#8997;&#9166;"): app-design flagged it as a nit from this
  session's hotkey change. Now one `&#8997;Space` chip in both places.

### The rest of the retired tokens: --beacon-wash (2026-09-27)

- `styles.css` still had `--beacon-wash` and used it for backgrounds: `.dest.do` (dead CSS, no
  markup used it, so it's gone), `.held-chip`'s fill, and `.ph-card`'s left border. Violet
  (`--beacon`) is text only, for "needs you" and nothing else, matching the real palette
  (`core/config/palette.js` has `beacon-ink`/`beacon-dot`, never a wash). `.held-chip` keeps its
  violet text and its dot; the fill is gone. `.ph-card` keeps its "Needs you" label above it and
  loses its accent border.

### Gold retired, the real Capsule hotkey, and app-design's launch art (2026-09-27)

- `index.html`, `styles.css`: removed the last gold from the page. app-design's review found it
  still styling the whole memory section (`--recall`/`--recall-wash`, the `.gold` utility, the
  recalled-answer card, the legend swatch, the terminal glimpse's "recalled" chip). Design A
  retired gold completely; every one of those now reads as a plain source chip or plain text
  (`--bone`/`--stone`, a `1px solid var(--rule-strong)` border, no fill), the same pattern
  app-design's Og board uses ("From · Q3 report · Harlow Legal · Tue"). The `--recall`/
  `--recall-wash` tokens are gone from `:root`.
- Fixed the Capsule hotkey copy: capsule-pro confirmed the default is Option-Space, with Control
  twice as an optional toggle (menu-bar mark, needs Input Monitoring), not the only way in as
  the page previously said. Updated the hero hint, the feature list, the settings preview, the
  keycap icons (now &#8997; + Space), and `app.js`'s demo listener (opens on Option-Space or
  Control-twice); `site/start/index.html` too.
- `docs/brand/`: replaced og.png, social-preview.png and readme-hero(.png/-light.png) with
  app-design's audited Design A renders (both themes; `-paper.png` added for each). `site/og.png`
  updated to match (dark only; that's the one the page's `og:image` meta uses).
- `index.html`, `styles.css`: reworked hero to lead with "Your best work, with a partner that
  never drops the thread." and brought the rest of the page in line with the Design A boards and
  `lib/theme/tokens.json`.
- `404.html`: rebuilt self-contained (does not load `/styles.css`, so a stylesheet change can
  never break it) with its own small Capsule field and an orbiting dot around the "0" that quiets
  under `prefers-reduced-motion`.
- `install.sh` terminal look: numbered steps, a check per step, a calmer finish line; unchanged
  flags, exit codes and `VYRE_NO_UP=1`. Verified with `test/install-box-look.test.js` and
  `core/names/system.test.js` (65 passing, plain ASCII under NO_COLOR/CI, colour and the mark on
  a real terminal).
- `deck/onboard`: look and copy only (logic stays with sessions): a step progress bar, a polite
  live-region announcement per step, softer copy when setup isn't running yet or the link needs
  reopening.
- Fixed the `npm install -g vyre` bug in `README.md`: 0.1.0 has no npm package; the quickstart now
  matches install.sh and this page (curl installer, or the Mac npm-tgz line).
- Fixed the install tabs (Linux box / Mac / What it needs): `.ipanel`'s own `display: flex`
  outranked the browser's default `[hidden] { display: none }`, so all three panels showed at
  once on load, and nothing wired the tabs' clicks in the first place (`app.js` had no listener
  for `.itabs`). Screenshot-verified on testbox with `vyre-chrome --headless=new`: the Mac and
  What-it-needs panels are hidden until their tab is picked.

### The first landing page (2026-09-26)

- `index.html`: the page, built from the Landing, LandingMobile and LandingCapsuleDemo boards in
  `docs/design/boards/`, with copy checked against SPEC.md sections 1, 7.5, 7.11, 8, 9, 10 and 11.
  It covers the install (`npm install -g vyre`, then `vyre up` and the six onboarding steps),
  your address, the assistant and agents, projects and the `vyre` home, the surfaces, the Capsule,
  memory in gold, enforced learning, the Vault, the nine-rule security floor, and how the box,
  Mac and tailnet fit. A line drawn around the middle of the page marks what runs inside your
  tailnet.
- `app.js`: copy buttons; typing a name updates `yourname.vyre.run` across the page; the Capsule
  state buttons; and the Capsule demo in a native `<dialog>`. Pressing Control twice opens it and
  Esc closes it. Typing `@kit`, `@pax` or `@juno` changes where the message would go. Nothing
  typed leaves the page.
- `styles.css`: only colours from `docs/design/TOKENS.md`. Works from 360 px up, has visible focus
  states, and turns off motion under `prefers-reduced-motion`.
- `favicon.svg` (the Lead mark), `apple-touch-icon.png` and `og.png` (1200 by 630), rendered with
  headless Chrome from the tokens.
- About 140 KB in total, fonts excluded.
