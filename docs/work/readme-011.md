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

## Round 3: three picture stories, not a features grid (team-lead)
Team-lead's messages crossed: 010fab24 still showed the rejected headline at the time they wrote,
but 8ea7dc65 (committed before their message landed) already has the final copy. No further
headline change needed this round.

What changed: replaced the picture set. Dropped teammates/vault/avatars images (kept those
bullets as text only) and built exactly the three the user cares about:
- Capsule: `capsule-ask.png` (the command bar answering from memory, with a cited past session)
  and `capsule-menu.png` (the menu bar popover: Open Capsule Option-Space, Quit). Both from the
  scratchpad's existing synthetic renders (who-2-reply.png, who-1-popover.png), opened and
  checked before use, both alex/Northwind sample data.
- Wink: `wink-confirm.png`, the real "Pair with alex-box? Code a1b2 c3d4" confirm screen. Real
  code, not a mockup: a small harness page (temp file, not committed) imported the actual
  `deck/js/dom.js` h()/put(), `deck/js/icons.js`'s icon(), `deck/views/pair-scan.js`'s real
  `initial()`/`step()` state machine, and `deck/css/pair.css`, then reproduced pair-scan.js's own
  `render()` confirm-branch markup verbatim, driven to state via `step()` calls (not hand-drawn
  HTML) with the exact name/fingerprint format `deck/views/pair-scan.test.js` uses as its own
  fixture ("Alex's box" / "a1b2 c3d4", here "alex-box" to match the sample world's real host
  name). Served over a throwaway python static server on testbox (stopped after, confirmed no
  process left with `ps aux`), headless Chrome at phone width (390px), center-cropped to the
  content. Did not attempt a real camera+relay scan flow (getUserMedia faking plus a live ticket
  exchange) given the time budget; this gets the identical shipped markup/CSS/state without it.
- Deck: kept `deck-chat.png`/`.dark.png` from round 1 (already shows a chat thread's avatars AND
  the account's other projects in the sidebar, so it covers "Deck chat with avatars and project
  tiles" on its own).

## Round 4: reviewer's relay HOLD + team-lead's own README draft
Two things landed together:

1. Reviewer HELD 8ea7dc65 (MEDIUM, public claim accuracy): site/index.html, site/llms.txt and
   README all overstated "vyre.run holds one DNS record and nothing else" - a paired phone's
   ongoing session traffic actually stays on the relay (relay.vyre.run, ADR 0046), end-to-end
   encrypted, so the relay sees routing metadata (who talks, when) but never content or keys.
   Fixed in all three places with the same fact, reviewer's suggested wording adapted to each
   surface's voice: site/index.html's FAQ answer, its short "outside the line" diagram caption
   (a second, shorter overstatement of the same claim I found while fixing the FAQ one), and
   site/llms.txt's Data section (also fixed llms.txt's Tailscale-auto-setup line to match the
   README draft's corrected claim: Mac Tailscale setup is manual, Vyre never touches it; only
   Linux/Windows desktops auto-join the tailnet in 0.1.1, Macs follow in 0.1.2).
2. team-lead rewrote the README body itself (team/README-0.1.1-draft.md, then updated again with
   the reviewer's relay wording) after finding stale/inaccurate lines in my drafts. Used it
   VERBATIM per instruction, only converting the four [PICTURE: ...] markers to real <picture>
   blocks. Checked every non-obvious factual claim in it against code/docs before shipping
   (nothing was wrong, so nothing was changed): "vyre capsule install builds the Capsule on your
   Mac; nothing is downloaded" matches docs/get-started/install.md:373 near-verbatim; "Vyre never
   changes your Mac's Tailscale settings" matches docs/adr/0014-tailnet.md's "Vyre never changes
   the tailnet" and install.md:89; "Macs follow in 0.1.2" matches
   team/BACKLOG-0.1.2.md:6 exactly ("In 0.1.1 only Linux and Windows desktops auto-join... Mac
   desktops auto-join the tailnet [is 0.1.2]").

Four pictures, all opened and checked before use:
1. capsule-ask.png: who-2-reply.png (Capsule answering "what is on the Northwind Bakery menu"
   from a cited past session), unchanged.
2. capsule-chip.png: chip-top.png, the Capsule's collapsed bar with the Northwind Bakery project
   chip top right (swapped out my round-3 pick, the menu-bar popover, which wasn't "the project
   chip").
3. wink-confirm.png: re-rendered with the sample box name "kit" per this round's instruction
   (was "alex-box"), same real dom.js/icons.js/pair-scan.js/pair.css method as round 3.
4. deck-chat.png: re-rendered fresh via `npm run docs:shots -- --only deck-project,deck-chat` on
   testbox rather than reusing the round-1 shot, since docs:check confirms deck-project.png was
   stale against deck/index.html, deck.css and views/projects.js, and the point this round was
   specifically "with the new avatars visible." Confirmed the new render does show the current
   avatar system (a drawn avatar in the sidebar, not the old plain "A" letter circle) and current
   sentence-case UI copy. FOUND A REAL BUG in that regeneration, not mine to fix: the light and
   dark PNGs it produced were byte-identical (same md5) - dark mode never actually applied during
   that docs:shots run. Rather than ship a mislabeled "dark" image, I dropped the dark variant for
   this shot and used the single light PNG only. Flagging the bug to team-lead/whoever owns
   docs:shots; did not touch docs/using/shots/ itself (only copied the regenerated PNG into
   docs/images/readme/), so the repo's own docs shots are unaffected by this.

## Round 5: two pictures redone, one real bug found and diagnosed (team-lead)
team-lead rejected two of the four pictures (Capsule ones were fine):

**wink-confirm.png**: the black camera circle looked broken. Redone as the real DONE/success
state instead of confirm (team-lead offered either): drove `step()` through
found->resolved->confirm->paired to `done`, then called `deck/js/pair-avatar.js`'s
`renderPersonAvatar({ identityFingerprint })` with a sample 8-byte fingerprint - the exact same
function `deck/js/pair-scan.js`'s own `renderAvatar()` calls once pairing succeeds - to get a
real drawn avatar SVG and swap it into `.scan-avatar`, matching shipped behavior exactly. Added a
simple phone-bezel wrapper (rounded frame, small notch, margin) around the real markup so the
crop reads as a device screen. Shows "Paired with kit as alex's iPhone. Code a1b2 c3d4."

**deck-chat.png**: found the actual root cause rather than re-rendering the same broken view.
`docs/using/shots/deck-project.png` (what I'd used) comes from `/projects/<slug>`, whose
`Threads` tab has its own SEPARATE message renderer -
`deck/views/projects.js:687 message()` - that still builds plain-text `initial(who)`/`initials(who)`
letter badges and was never migrated to `deck/js/avatars.js`'s `personAv`/`agentAv` (the ones
`deck/chat/blocks.js` uses, native-core's avatars work, merged into stage/0.1.1 at d77479bd).
Confirmed by reading both files, not by guessing: no page-error was logged during the shot (ruled
out an exception), and `avatarSource()`'s code paths for `family: "agent"`/`"person"` have no
letter-fallback branch that isn't the `catch`. Real fix belongs to whoever owns
`deck/views/projects.js` (flagged below, not touched here - out of scope for a README pass).
Worked around it correctly instead: `/chat/harlow-legal/<session>` (the SAME thread, opened
through the Chat view rather than the Projects view) uses the current, avatar-wired renderer and
already shows the Harlow Legal project tile in both the header and the sidebar, alongside
Northwind Bakery's tile - exactly what was asked for, with zero PII (no Brief panel on this
route). Rendered both themes with a throwaway `deck/test/world.js` (a test helper, temp home,
removed after; confirmed no process or port left with `ps`/`lsof`) and the same
`scripts/lib/docs/chrome.js` CDP helper docs-shots itself uses, forcing
`Emulation.setEmulatedMedia` for the dark shot (the world's `appearance.scheme` is "system", and
headless Chrome defaults to light, which is why round 4's shot came out "paper" despite no
`data-theme` override - not a bug, just an unset media emulation on my part).

## Next
- Waiting on reviewer's second privacy/accuracy pass and team-lead's read before deploying
  vyre.run (their instruction: don't deploy until both).
- Flag three open items to team-lead:
  1. Real bug, not fixed here: `deck/views/projects.js`'s own thread message renderer
     (`message()`, line 687) never got migrated to the avatar system - whoever owns that view
     should wire it to `personAv`/`agentAv` like `deck/chat/blocks.js` already does.
  2. The docs:shots dark-mode gap from round 4 (light/dark came out byte-identical) - now
     understood: that pipeline doesn't force `prefers-color-scheme` for the dark pass, so it only
     works when the sample world's scheme is explicitly "dark"/"paper", not "system". Worth a
     one-line fix in `scripts/docs-shots` for whoever owns it.
  3. docs/brand/readme-hero*/social-preview*/og-paper still carry the old rejected headline
     (app-design's launch art, not mine to hand-edit).
- Did a full pass on the relay/DNS claim everywhere I could find it; only spot-checked the rest
  of site/index.html's feature-line framing (Mac/phone/server) given time - no other inaccuracies
  found in what I checked, but I didn't read all ~600 lines line by line this round.
