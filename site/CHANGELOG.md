# vyre.run changelog

Newest first. The landing page is a static site: `index.html`, `styles.css`, `app.js` and a few
assets, with no build step and no framework. Fonts load from Google Fonts; the one script is local.

## Unreleased

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
