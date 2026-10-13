---
title: Vyre mark
summary: The Vyre wire drawn as a glass tube ending in a bead of light, with four states: static, intro, working, done.
audience: builders
owner: app-design
status: draft
---

# Vyre mark

The approved master (`docs/design/brand/export/vyre/vyre-master.svg`, and `vyre-small.svg` under 48 px), used as given. Nothing is redrawn: `apps/app/scripts/gen-vyre-mark.mjs` copies the files into `ui/marks/vyre-art.js`, and `ui/marks/vyre-mark.js` changes only two things over time, how much of the tube is drawn (a stroke-dash reveal on the masks the glass is cut with) and the light of the bead. Brand rules: `docs/design/brand/README.md` (light from the upper left, warm Bone, no violet).

| Surface | Implementing file | Status |
|---|---|---|
| App | `apps/app/ui/components/VyreMark.tsx` (@vyre/ui) | built |
| Web page and shells | `apps/app/public/splash.html`, from `scripts/gen-splash.mjs` | built |

## States

| State | Motion | Where |
|---|---|---|
| static | none | the lockup at the top left of every flow screen (sm, with the word Vyre) |
| intro | 900 ms: the wire draws in over the first 62 percent, then the bead's light comes on | the first screen, large and centred |
| working | a slow breath of the bead's light, 2.4 s a cycle, between 55 and 100 percent, no other movement | while something waits: approving on another device, setting up a space, placing a vault |
| done | one bright pulse out of the bead over 700 ms, then rest | Ready, and when a wait ends |

Sizes: sm 28 (small master), md 56, lg 112. Reduced motion: every state is shown at once and nothing loops.

## Splash

`public/splash.html` is self-contained (HTML, CSS, the master as inline SVG with private ids). Its background is `tokens.v2.color.{dark,paper}.bg`, so there is no white flash. It plays the intro in CSS (950 ms), and fades when the app calls `window.__vyreSplashDone()` once the first screen is up; a page that never calls it clears itself after 9 s. The same file is what the Mac and Windows shells show while the web view loads. Run `node scripts/gen-splash.mjs` after a token or brand change.

## Gaps

- [ ] The splash hands off by a cross-fade, not by the mark travelling into its place.
- [ ] The one-colour `vyre-template.svg` is exported (`TEMPLATE`) but no surface uses it yet.
