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

## How to rerun the shots (the test box)
- `rsync -a --delete --exclude node_modules --exclude .git ./ the test box:~/vyre-ci/pwa/`
- Chrome: `docker run -d --rm --name vyre-pwa-chrome --network host --shm-size=1g chromedp/headless-shell:latest --remote-debugging-port=9422 --remote-debugging-address=127.0.0.1`
- World: `cd ~/vyre-ci/pwa && VYRE_NO_DIALOGS=1 nice -n 15 node deck/test/world.js 4790`
- `CDP=http://127.0.0.1:9422 node deck/test/pwa-shots.js http://127.0.0.1:4790 ~/vyre-ci/pwa-out`
  (`ONLY=<regex>` for some screens). Stop the world and `docker stop vyre-pwa-chrome` after.

## Doing
- Nothing running. Waiting on the lead to try it on the phone.

## Next
- Wire the queue once capsule-now names it (composer.js `sendInput`, QUEUE SEAM comment).
- See a live streamed reply in a browser: the world has no harness, so streaming is unit-level only.
- Real iPhone check by the user: launch screens, push on the Home Screen app, Face ID passkey.
- A monochrome badge icon for Android notifications (the colour icon shows as a white square).

## Needs from others
- capsule-now: the queue-to-busy-session contract (tool and event names). Asked 2026-09-27.
- link / files: the box cannot search the Mac's files (link carries Mac to box only). Find says
  "Files on your Mac show here when your Mac is online."
- lead or e2e: confirm the phone's first passkey code comes from `vyre presence code` on the Mac
  (the box refuses terminal codes, ADR 0004). The card says "on your Mac".
- mobile: told the tool names, push payload and tab order so the native apps match.

## Changed contracts
- Tabs on the phone: Now, Projects, Chat, Find, Agents (Ask moved off the tab bar; /ask stays).
- api.js exports `reachable` and fires `deck:reach` on window. No tool or event changes.
- Now's first child on a phone may be the setup card (phone-setup.js).

## Perf
- No timers or polls added. The offline line rechecks only on `online`, on becoming visible while
  shown, and on Retry. Pull to find uses passive touch listeners. The SW install fetches about 45
  small files once per version.
