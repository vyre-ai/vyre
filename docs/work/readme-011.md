# readme-011 (site-copy)

Scope: rewrite the GitHub README (positioning + pictures) for the 0.1.1 launch. Branch
`work/readme-011` off `stage/0.1.1` (21901bb8), worktree `../vyre-site-copy`.

## Done
- Repositioned the README around "Claude Code, running on your own machine." plus the two-line
  follow-on the lead approved.
- Rewrote the feature list to only what shipped in 0.1.1 (checked against CHANGELOG.md's 0.1.1
  section): the Deck (chat, sessions inline, voice, /goal /later /find), teammates, the Mac
  Capsule, Wink (confirmed the phone.vyre.run scan destination against docs/adr/0045-wink.md and
  docs/work/pwa.md), tailnet auto-join, GitHub sign-in and repos, the vault, memory across
  sessions, Apache 2.0.
- No invented numbers, no 0.1.2 backlog items, no em dashes, no section signs.
- Added `docs/images/readme/`: deck-chat (light+dark), teammates (light+dark), vault
  (light+dark), avatars (dark only). All copied from the repo's own checked-in, current
  `docs/using/shots/` library (retaken on main post-0.1.1-release per git log, so not stale) plus
  one avatar family sheet from app-design's synthetic testbox render
  (`~/vyre-ci/avatar-shots/gallery-dark.png`, alex/Northwind/Harlow Legal sample world only).
  Opened and eyeballed every PNG before using it; no real names, emails or tokens in any of them.
  Each file is under 100 KB.
- Did not generate new screenshots for Wink's phone-scan ring or the GitHub repo picker: no shot
  exists for either in `scripts/lib/docs/shots.js` yet (that pipeline is owned by
  tailnet/github/pwa), and the existing `onboarding-devices` shot predates the Wink pivot, so
  using it would have shown the wrong (pre-Wink) UI. Described both features in prose instead of
  misrepresenting them with a stale picture.
- Verified `npm run test/hygiene.test.js` passes on testbox: no names, no secrets, no retired
  coral references.
- Verified every image path in the README resolves to a real file.

## Needs from others
- `npm run docs:check` on testbox fails with 264 pre-existing "shot older than source" problems
  on a clean `stage/0.1.1` checkout too (confirmed against a second worktree with no README
  changes), so this is not something readme-011 introduced. Whoever owns `npm run docs:shots`
  should retake the full set before the tag if that matters for the release; flagged to
  team-lead/integrator, not fixed here (out of scope for a README pass).

## Next
- None. Ready for reviewer's privacy check and the integrator's merge after the v0.1.1 tag.
