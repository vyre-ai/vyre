# vyre.run changelog

Newest first. The landing page is a static site: `index.html`, `styles.css`, `app.js` and a few
assets, with no build step and no framework. Fonts load from Google Fonts; the one script is local.

## Unreleased

### Landing, 404 and install polish for the 0.1.0 push (2026-09-27)

- `index.html`, `styles.css`: reworked hero to lead with "Your best work, with a partner that
  never drops the thread." and brought the rest of the page in line with the Design A boards and
  `lib/theme/tokens.json`: no gold anywhere, violet reserved for "needs you" only.
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
