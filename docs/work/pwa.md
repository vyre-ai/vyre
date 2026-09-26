# pwa

Branch: work/pwa · Worktree: ../vyre-pwa · Owner session: pwa

Scope (lead, 2026-09-27): the phone app ships first as the Deck installed as a web app (PWA) over
Tailscale; the native apps (team mobile) come after, on the same API and design. Branched from
work/polish-surfaces (phone Chat, five tabs, title truncation), with main merged in (2e5d78a).

## Install it on an iPhone

1. Install the Tailscale app from the App Store and sign in with the same account as the box.
   Turn the VPN on (the switch in the Tailscale app).
2. Open Safari (it must be Safari: only Safari can add a web app to the Home Screen with push)
   and go to the box's address, `https://<you>.vyre.run`, or the box's `https://<box>.<tailnet>.ts.net`
   name if there is no vyre.run name yet. The Deck opens at Now.
3. Tap Share (the square with the arrow), scroll, tap Add to Home Screen, then Add. Vyre appears
   on the Home Screen with its icon.
4. Open Vyre from the Home Screen, not from Safari. It runs full screen. On Now, "Set up this
   phone" has two steps left:
   - Notifications: tap Turn on, then Allow. iOS 16.4 or later, and only in the Home Screen app.
   - Passkey: run `vyre presence code` on your Mac, type the code, tap Add, and confirm with Face
     ID. Send, Discard, Allow and Deny then ask for Face ID.
5. Pull down from the top of any screen, or tap Find, to search everything.

Android: Chrome, same address, then Install app from the menu (or the Install button on Now).

## Done
- 2e5d78a merge main into work/pwa (CHANGELOG kept both sides, world.js kept breach: off).
- Shell (deck/index.html, manifest.webmanifest, css/deck.css, js/pwa.js): standalone manifest with
  id, maskable icons, shortcuts (Now, Chat, Find); Apple touch icon (full bleed, 180); launch
  screens for 12 iPhone sizes (deck/splash, made by deck/test/pwa-assets.js); iOS meta tags;
  safe-area padding on the shell and tab bar (`--tabbar-total`); `overscroll-behavior: none` on
  the page and `contain` on the view; status bar colour follows the theme.
- Find (views/find.js): the phone Capsule. Tab replaces Ask (Ask still at /ask); pull down 72 px
  from the top of any phone screen opens it (only when everything under the finger is at the top,
  never from a field).
- Chat (deck/chat/*): session fills the view, stick-to-bottom while streaming plus Jump to latest,
  threads.send's {sent:false, note} shown as a note with the draft kept and Try again, a queue seam
  (`sendInput`, `data.queued` pill), asks and held drafts with presence and a result line, 16 px
  inputs, 44 px targets. Edited To goes as a list (was one string).
- Presence: deck/js/needs.js answers (gate.approve/reject, threads.answer) now carry a passkey
  proof. They were refused with presence_required before (all three are HUMAN_ONLY).
- Phone setup (js/phone-setup.js): install, notifications, passkey card on Now; settings.js uses
  its subscribePush/enrollPasskey, one implementation.
- Offline: sw.js keeps the shell and the phone tabs at install (SHELL list, cache vyre-deck-2);
  api.js reports reachability (`deck:reach`); pwa.js shows one line; a cold launch reopens the last
  screen from the last day.
- Tests: deck/test/pwa.test.js (5, all pass on the test box): every SHELL path exists, every module a
  phone tab imports is kept, manifest icons exist, iOS tags and launch screens exist, the SW's
  tool-cache invariant. Targeted deck suites on the test box: 68/68 pass.
- Shots: deck/test/pwa-shots.js, 13 screens x 390x844 and 430x932 = 26 shots, all checks pass
  (no sideways scroll, tab bar present, standalone, no page errors, pull releases to /find, reopen
  lands on the last screen). iPhone UA, touch, 3x, safe areas 47/34 and 59/34.

- After ci's history rewrite the pairing card is 845f637. Since then: first-passkey card on Now
  and the iCloud Keychain line on the pairing card; memory.relevant for the owner's tailnet devices
  and system.info owner.name (116ceb7, tests in core/memory/access.test.js and test/daemon.test.js);
  Find commands (76d473f, deck/js/commands.js + commands.test.js, the mobile/Capsule grammar);
  /theme.css from config theme.colors (394753a, core/config/theme.js + tests, daemon route).
- Shots: 56 (19 screens at 390 and 430, plus onboarding, pairing, no assistant and Now at 1280,
  1440, 2000), all checks pass.

## How to rerun the shots (the test box)
- `rsync -a --delete --exclude node_modules --exclude .git ./ the test box:~/vyre-ci/pwa/`
- Chrome (connectors' shared install): `/usr/local/bin/vyre-chrome --headless=new --remote-debugging-port=9422 --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/pwa-chrome-prof about:blank`
- World: `cd ~/vyre-ci/pwa && VYRE_NO_DIALOGS=1 nice -n 15 node deck/test/world.js 4790`
- `CDP=http://127.0.0.1:9422 node deck/test/pwa-shots.js http://127.0.0.1:4790 ~/vyre-ci/pwa-out`
  (`ONLY=<regex>` for some screens, `DESKTOP=1280x800,1440x900,2000x1100` adds desktop sizes,
  `PHONES=0` drops the phones). Stop the world and Chrome after (pids in /tmp/pwa-*.pid).

## Doing
- Pushed work/pwa; integrator told the tip is ready. 1cd5346: Create your assistant offers a computer.
- Waiting for the user to pair his Mac, then: check the phone PWA against his real box, read-only,
  with the Mac's sessions showing (federation), and fix what looks off.

## Next
- Settings > Setup rows could rerun a step in place (polish-cli's suggestion) instead of naming
  `vyre up`.
- Step 6 Mac card: "Already on your tailnet" for an online Mac node.
- theme.colors: match docs' final shape (asked docs: "light" or "paper", shared validator).
- threads.unqueue once capsule-now ships it.
- Real iPhone check by the user.

## Needs from others
- polish-cli answered: no --step; Settings says `vyre up` (and `vyre index` for history).
- box: review the additive `onboard.status` detail.devices.peers and parsePeers (core/onboard).
  Also onboard.finish sends auth {vault: "anthropic-api-key"} for an API key, which agents reads as
  a subscription token (the assistant card sends {fallback: "anthropic-api-key"} instead).
- e2e: confirm the passkey on the user's box has the right rpId (the lead asked them).
- docs: the theme.colors shape.
- link / files: the box cannot search the Mac's files (link carries Mac to box only). Find says
  "Files on your Mac show here when your Mac is online."
- lead or e2e: confirm the phone's first passkey code comes from `vyre presence code` on the Mac
  (the box refuses terminal codes, ADR 0004). The card says "on your Mac".
- mobile: told the tool names, push payload and tab order so the native apps match.

## Changed contracts
- memory.relevant: tailnet:<login> callers may read without a room (was refused).
- system.info: adds owner { name } (onboard.person).
- GET /theme.css served by vyred from config theme.colors.
- onboard.status: detail.devices.peers [{name, dns, os, online, lastSeen}] (additive), parsePeers export.
- docs/JOURNEY.md step 6 describes pairing the Mac and Add to Home Screen.
- Tabs on the phone: Now, Projects, Chat, Find, Agents (Ask moved off the tab bar; /ask stays).
- api.js exports `reachable` and fires `deck:reach` on window. No tool or event changes.
- Now's first child on a phone may be the setup card (phone-setup.js).

## Perf
- No timers or polls added. The offline line rechecks only on `online`, on becoming visible while
  shown, and on Retry. Pull to find uses passive touch listeners. The SW install fetches about 45
  small files once per version.
