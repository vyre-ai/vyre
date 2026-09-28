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

## Round 2: user's final copy (team-lead, 28 Sep)
User rejected the first headline ("Claude Code, running on your own machine.": true but says
nothing a reader couldn't already assume). Final copy, used verbatim:
- Headline: "Your agents live on your server. Reach them from your Mac or your phone."
- Intro: "Vyre is an open-source, self-hosted home for Claude Code agents. They run on a server
  you own, keep working when your laptop is closed, and answer when you press Option-Space on
  your Mac or open Vyre on your phone."
- Security line: "Your API keys stay in an encrypted vault on that server. Anything that sends a
  message, posts or pays waits for your Touch ID or Face ID."

Verified both security-line claims against code before shipping (forked a check): vault is
AES-256-GCM at rest, key held outside the vault folder (docs/adr/0001-vault-crypto.md). Send/
post/pay gating by Touch ID or Face ID is real and current: the user's own rule in
docs/adr/0004-presence.md:305, iOS Face ID via LAContext/Secure Enclave in
apps/ios/Vyre/Presence/DeviceKey.swift and apps/app/modules/vyre-signer, Mac Touch ID via the
0.1.1 Secure Enclave change (CHANGELOG.md). Both true as written, no softening needed.

Done this round:
- README: new headline/intro/security line, cut the "forty scattered transcripts" invented
  number from "Who it's for", added a "Questions" AEO section (what is it / what do I need / what
  does it cost / what leaves my server / how do I add my phone), each answer checked against
  actual behavior.
- site/index.html: matching hero H1 + two lead paragraphs, `<title>`, meta description, og/
  twitter title+description, added JSON-LD SoftwareApplication (validated: parses as JSON), FAQ's
  "Where does my data live?" now says explicitly that prompts still go to Anthropic's API through
  Claude Code, bumped the stale "0.1.0" FAQ reference to 0.1.1.
- site/llms.txt: new, plain facts only (what it is, what runs where, install, cost, data, license,
  docs link).
- Regenerated the social image at the new headline, 1280x640: quick standalone HTML render (not
  app-design's "Design A" pipeline, see gap below), headless Chrome on testbox only, verified the
  bottom "vyre.run" line wasn't clipped before shipping. Replaced site/og.png and the user's
  GitHub OAuth app image (same file in Downloads I wrote earlier today with the rejected
  headline, now updated). Source kept at docs/brand/og.html.
- docs/work/gh-repo-meta.sh: the `gh repo edit` command for the integrator to run after merge
  (description + 6 topics per the lead's list). Not run myself, not my repo to edit.

Gap, flagged rather than papered over: docs/brand/{og-paper,social-preview,social-preview-paper,
readme-hero,readme-hero-light}.{html,png} are app-design's actual launch art ("Design A", per
docs/work/launch-surfaces.md's "Received app-design's launch art... Og, Social, ReadmeHero, both
themes"), and still carry the OLD, rejected headline. I did not touch them. If any of those need
to change (readme-hero.png in particular looks built to be the README's actual hero image, which
I didn't use), that's app-design's pipeline to re-export, not something I should hand-edit with a
plain HTML mockup. Flagged to team-lead.

## Next
- Waiting on reviewer's privacy check before deploying vyre.run (team-lead's instruction: deploy
  after that check, same deploy the user already approved).
- Waiting on team-lead reading every line before it ships (their ask).
- Flag the stale docs/brand/readme-hero*/social-preview*/og-paper assets to app-design/launch.
