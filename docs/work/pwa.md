# pwa

Branch: work/pwa · Worktree: ../vyre-pwa · Owner session: pwa

Scope (lead, 2026-09-27): the phone app ships first as the Deck installed as a web app (PWA) over
Tailscale; the native apps (team mobile) come after, on the same API and design. Branched from
work/polish-surfaces (phone Chat, five tabs, title truncation), with main merged in (2e5d78a).

## Phone-side contract: scan your avatar to pair your phone (for launch, 2026-09-28)

launch can't message pwa directly, so this section is the handoff: what the Deck's "Add your
phone" screen needs to know about what happens after it shows the code. Written after reviewer's
verdict on work/pwa bdca618b redesigned the ticket handling (see "Doing" below for why); sha
9408fb66 has the doc fix, the redesign itself lands in this session's next commit.

**No Tailscale in this flow, relay only** (team-lead, 2026-09-28) — the phone never touches the
tailnet; everything below goes over the relay (`relay/client/client.js`'s `pair()`, the same
library the Expo app uses) or a plain HTTPS fetch to a directory host.

1. **The Deck mints a ticket and shows it as a code ring** around the person's avatar (tailnet +
   app-design's side, not pwa's). The ticket is 8 random bytes; the ring encodes it plus a CRC-8
   and Reed-Solomon parity (`deck/vyrecode/payload.js`), 144 bits total, in app-design's 2-ring/
   36-mark/2-bit-per-mark layout. Per reviewer: **Touch ID happens here, at mint** (option A) —
   not later, at redeem.
2. **The phone scans it** (`deck/js/scan.js`): camera → decode-core2.js's search → an 8-byte
   ticket, recovered but never turned into a string, logged, or put in a URL (it is this flow's
   pairing secret — see point 3).
3. **The phone resolves the ticket to a box identity WITHOUT sending the ticket itself**
   (`deck/js/pair-ticket.js`, reviewer's HIGH 1 and HIGH 2 on bdca618b). It derives three values
   locally with domain-separated SHA-256:
   - `locator = sha256("vyre-pair-loc" || ticket)` — sent to the relay/directory; on its own it
     only names a row, it doesn't let anyone pair.
   - `secret = sha256("vyre-pair-sec" || ticket)` — used as the Noise handshake's pairing secret
     in step 5; never transmitted.
   - `macKey = sha256("vyre-pair-mac" || ticket)` — verifies the resolved record before trusting
     anything in it.

   **ASSUMED, not confirmed with tailnet:** `GET <PAIR_BASE's origin>/api/pair/ticket/<locator>`
   (`PAIR_BASE` is `relay/client/client.js`'s own `https://vyre.run/pair`), returning JSON
   `{ relay, route, box (base64url, 32 bytes), mac (base64url), name, handle }` — `handle` is
   this file's own addition for the redirect in step 6, also unconfirmed. Refusals: 404 →
   `ticket_not_found`, 410 → `ticket_expired`, 409 → `ticket_used`, 429 → `rate_limited`. The
   phone computes `expectedMac = hmacSha256(macKey, utf8(route) || box)` and refuses
   (`bad_ticket`) if it doesn't match `mac` — this is what stops a compromised relay from
   substituting a different box. The fingerprint shown to the person is computed locally from
   the verified `box` public key (`sha256(box).slice(0,4)`, hex, grouped) — never the server's
   own word for it. **TODO**: swap for the shared `keyFingerprint()` once it exists somewhere in
   this tree, so both sides format it identically; not found yet.
4. **The person confirms**: "Pair with `<box>` (`<fingerprint>`)?" with an editable "Name this
   device" field, pre-filled from User-Agent Client Hints' `model` (Android: often the real model,
   e.g. "Pixel 8"; iOS Safari has no UA-CH at all) prefixed with the person's first name (from
   `system.info`'s `owner.name`) — "Alex's iPhone" (team-lead's decision, 2026-09-28). Tapping
   "Not this one" goes back to scanning without contacting anything past step 3.
5. **The handshake**: `deck/js/pair-ticket.js`'s `completePairing()` builds the same offer-URL
   shape `relay/client/client.js`'s `parsePairUrl` expects from the verified `relay`/`route`/`box`
   and the LOCALLY-DERIVED `secret` (never the response's own fields past `relay`/`route`/`box`),
   and calls that same file's `pair(offerUrl, { name, about: { kind: "web" } })` — no separate
   presence/Touch-ID call from the phone (dropped per reviewer's MEDIUM: that gate is step 1's
   job, and `relay.join`/`presence:true` was the wrong tool anyway — `relay.join` refuses on
   darwin and is for a Vyre joining another box, not this). The box, other devices and the Deck
   learn about the new device the normal way, via relay's own `device.paired` notice ("Alex's
   iPhone was added, just now. Not you? Remove it") — not something this flow raises itself.
6. **Success**: the phone shows the SAME avatar it just scanned (a small crop of the decoded
   camera frame, upright-rotated — not a redrawn copy; this scanner has no access to app-design's
   avatar renderer/seed) doing a short celebratory hop-plus-confetti (under 1.2s, skipped under
   `prefers-reduced-motion`, `deck/css/pair.css`'s `.ms-done`/`.confetti-bit`, ui-ux's motion
   prototype's "goal done" moment), then redirects to the person's own `https://<handle>.vyre.run`
   (ASSUMED to come back from step 3's resolve; confirm with tailnet).
7. **Errors**: worded per refusal code (see step 3's list, plus a pairing-side `denied`), always
   with a "Scan again" that returns to step 2 without re-deriving anything from a ticket the
   person no longer holds on screen.

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

## What to look at on your phone (after pairing the Mac)

1. Install. Tailscale on, then Safari to your address, Share, Add to Home Screen, and open Vyre
   from the Home Screen. You should see Vyre full screen: no Safari bars, a dark status bar, the
   five tabs (Now, Projects, Chat, Find, Agents) clear of the home bar.
2. Now. At the top, "Set up this phone" with Install ticked. Tap Turn on under Notifications and
   Allow. Under Passkey, if your Mac passkey synced through iCloud Keychain, approving anything
   will offer it with Face ID. Below, what needs you, then what is running.
3. Chat. Your Mac's projects and sessions are listed (Recent shows the latest). Open one: the
   conversation reads like the terminal, newest at the bottom. Type a line and send. If the
   session is busy in your Mac's terminal, a line says "Queued for <name>" and the message goes in
   when that turn ends.
4. Find. Pull down from the top of any screen, or tap Find. Type part of a session name, a file
   name or a person: sessions, box files, agents and memory show up as you type. Try
   "watch <a session>": the line under the box says what Enter will do; press it and you should
   get a notification when that session finishes or asks.
5. An approval. When something is held (a draft email) or a session asks permission, it shows on
   Now and in the Chat. Send or Allow asks for Face ID, then says Sent or Allowed.
6. Settings, Devices. Your iPhone and Mac are listed as online, the Mac marked "Paired with this
   box". If a device is offline in Tailscale, it says so in plain words.
7. Notifications. With the app closed, an ask or a held draft should arrive as a notification
   that says only that something needs you. Tapping it opens that item in Vyre.
8. Offline. Turn on Airplane Mode and open Vyre: it still opens, shows what it last had, and one
   line says the phone is offline. Turn it off and tap Retry: the line goes and the screen fills.

## The keyboard check (real iPhone only — a simulator or Chrome DevTools does not show this)

Everything above has been checked in headless Chrome on testbox, but the keyboard behaviour it is
built against (`visualViewport`, safe areas, `100dvh`) only shows its real shape on an actual
iPhone in Safari, so this is the user's to run rather than something the team can verify in CI. Takes
about five minutes. For each step, what should happen is next to what would mean it is broken.

1. Open a session with some history in it (Chat, pick one with a few messages). Tap the composer
   at the bottom. **Should**: the keyboard rises and the composer sits right on top of it, with no
   gap and no part of the composer hidden underneath; the transcript above does not jump, flash,
   or scroll to a different spot when the keyboard appears. **Broken** would look like: the
   composer staying at the bottom of the screen behind the keyboard, a visible jump in the
   transcript's scroll position at the moment the keyboard opens, or a blank gap between the last
   message and the keyboard.
2. With the keyboard still up, scroll the transcript up to read an earlier message, then scroll
   back down and type a short reply. **Should**: scrolling works normally with the keyboard up,
   and sending returns you to the bottom smoothly. **Broken** would be scrolling that fights the
   keyboard, or the view snapping somewhere unexpected on send.
3. Dismiss the keyboard (tap the transcript or swipe down) without sending anything, then tap the
   composer again. **Should**: it opens and closes cleanly a few times in a row with the layout
   settling in the same place each time. **Broken** would be the composer sitting too high or too
   low after a second or third open, or a growing gap under it.
4. Tap Send (or Approve) on the Gate to open its sheet, then tap into one of its text fields.
   **Should**: the sheet's field also rises above the keyboard, same as the composer. **Broken**
   would be the field ending up hidden behind the keyboard inside the sheet.
5. Pull down for Find and tap its search box. **Should**: the same lift as the composer; typing
   filters results live above the keyboard. **Broken** would be the results list being covered by
   the keyboard, or the search box itself sitting under it.
6. Turn the phone sideways (landscape) with the composer's keyboard up, then back to portrait.
   **Should**: the layout does not break in either orientation — this is also where to notice
   whether the phone should still use its narrow (five-tab) layout in landscape, or switch to the
   wider desktop-style one now that the screen is over 760px wide sideways; either way of it
   should look deliberate, not stretched or cut off.

Whatever you see, a screenshot (or a screen recording if it's the jump, which is hard to catch in
a still) is the fastest way to hand it back — reply with what step, and what happened instead.

## Done
- /pair for `vyre phone add --tailscale-only` (views/pair.js, js/pair-steps.js pure parts,
  css/views/pair-phone.css via app.js CSS_NAME): code + enrollPasskey, subscribePush, Home Screen
  words, the five checks from events. push.seen gains `device`. Tests: deck/test/pair.test.js (5).
- Person sessions, Deck side (e2e's contract, box side not on this branch; feature-detected):
  js/person.js (signIn, needSignIn sheet, installPersonHandler, signInAfterEnroll, signOutHere),
  api.js setPersonHandler + endPerson, Settings Security "Signed-in devices", sign-in after a
  passkey is enrolled (phone-setup enrollPasskey, onboard/passkey), "confirmed N min ago" on the
  cover line. Tests: deck/js/person.test.js (6).
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

- Speed (lead, from the user's iPhone): pages kept mounted (app.js router: mount/away/drop,
  KEEP 8), the tabs warmed at idle on a phone, Chat opens sessions from known rows with the last 60
  turns, Back is history.back, fonts self-hosted, SW stale-while-revalidate. deck/test/pwa-perf.js
  (tab first tap, revisit, Chat open/back/open) and pwa-perf.test.js. Numbers in CHANGELOG.
- Queue: threads.send queues for tailnet:<login> (was already true on main after capsule-now;
  queuesFor now also refuses an agent's tailnet node). If the user's phone still refused, his box
  runs code from before capsule-now's merge.

- C. iOS pitfalls (2026-09-27): fixed shell (`position: fixed; inset: 0`, 100dvh after a 100vh
  fallback, `html, body { overflow: hidden }` on the phone); the keyboard inset
  (deck/js/keyboard.js: one passive visualViewport listener while a field has focus on a phone,
  rAF-coalesced, `--kb` and `data-kb` on html, `deck:kb { kb, delta }`; Chat's composer and lease
  line lift by transform, the transcript's padding follows and session.js scrolls along; sheets
  stop at the keyboard; other pages get room); fields at least 16 px on the phone; safe-area
  insets on the shell at every width (landscape phones and iPads are over 760), sheets sideways;
  `touch-action: manipulation`, no callout or selection on chrome and rows, text selectable in
  messages and code; `content-visibility: auto` on transcript rows older than the newest 40, the
  Chat list and Find results; Now's row swipe writes once a frame and promotes the face only
  while it moves. The Send sheet says "Send" while a presence session covers the draft.
  SW cache vyre-deck-7. Tests in deck/test/pwa.test.js ("pwa ios: ...").
- Row swipes are still pointer-driven transforms, not a scroll-snap row. The conversion is a
  proposal in the report to the lead (it touches the swipe, commit, Undo and pager-lock logic).

## How to rerun the shots (the test box)
- `rsync -a --delete --exclude node_modules --exclude .git ./ the test box:~/vyre-ci/pwa/`
- Chrome (connectors' shared install): `/usr/local/bin/vyre-chrome --headless=new --remote-debugging-port=9422 --remote-debugging-address=127.0.0.1 --user-data-dir=/tmp/pwa-chrome-prof about:blank`
- World: `cd ~/vyre-ci/pwa && VYRE_NO_DIALOGS=1 nice -n 15 node deck/test/world.js 4790`
- `CDP=http://127.0.0.1:9422 node deck/test/pwa-shots.js http://127.0.0.1:4790 ~/vyre-ci/pwa-out`
  (`ONLY=<regex>` for some screens, `DESKTOP=1280x800,1440x900,2000x1100` adds desktop sizes,
  `PHONES=0` drops the phones). Stop the world and Chrome after (pids in /tmp/pwa-*.pid).

## Doing (saved before restart 5, 2026-09-27)
- Handed off: RC 15d02055 to the integrator (tests 494/493/1 skipped, Chrome check of Now ok
  at 390/430/1280); then c78b87c0 (budget 8 fix: backoff 250 ms, 500 ms, 1 s, doubling to 60 s; a
  kick when any tool call is answered while reconnecting; pill from attempt 4). The integrator
  decides whether c78b87c0 replaces 15d02055.
- Waiting on: native-core's budget 8 rerun on c78b87c0 (their harness is 26ef7da4; the 3,254 px
  jump is chat's 553017a1, not on main); main to carry cohesion (waiting, context, sight.frame
  0f4d1105), native-core fa349d31 (theme routes, snapshot device, Dark/Paper writes scheme) and
  app-design core/appearance, then one live check of each against the real modules.
- Next: docs' tips wiring (docs/build/tips.md, once tips is on main); the Glass header frame in a
  thread with chat (glass-mini.md Header variant); the tool row's Step link is chat's.
- No testbox processes running (Chrome and world stopped by process group).

## Doing (resumed after logout 4, 2026-09-27)
- READY for batch 4 sent to the integrator: 2a577ede (main 53cd1326 merged, pushed). Chrome check
  on testbox (deck/test/resilience-shots.js): pill, offline line, Retry, outbox once, /app/ route all
  ok; pwa-shots at 390/430/720/900/1280/1440 ok. Targeted tests 502, 501 pass, 1 skipped.
- Merge rules used (7880dfa6): api.js keeps follow() over fetch; e2e's signIn stopgap dropped;
  chat's answers and send via the outbox (queue() presence false for a Mac ask, so its passkey
  step stays on the card); deck/chat/api-stream.test.js dropped; tests use hear()/heardResume().
- Design A done since: d442d8e4 switch point 720; ff09ec5d token roles only (radii as
  var(--radius-*, px) until app-design 4b77ba51 is on main); 861a6d40 + 544e0f6f the 72 px rail,
  Cmd+1..9, route() hides the page left (old bug from c0edc567); 6c5df144 phone header and queued
  row fit the 44 buttons; 2a577ede a view that failed to import offline waits and remounts;
  79124ccd the Places sheet and a pinned fourth page (Chrome-checked at 390 and 430).
- native-core budget 8: their harness counts EventSource opens, which the fetch stream never makes;
  told them to use "deck:stream" or count /v1/events/stream fetches and rerun on 2a577ede. If
  catch-up is over 1 s: an immediate retry on "online" and on the first failure.
- Live theme done on the Deck side (ddc9b127, deck/js/theme-live.js, 7 tests), against ADR 0035's
  paths: settings.snapshot at start, /theme.css?device=&rev=, swap on settings.changed appearance.*
  and on a reconnect whose rev moved; feature-detected. Not tried against a real hub yet (the
  theme module is platform P4, not on main). Asked app-design and native-core to agree one route
  (app-design wrote /v1/appearance/theme). Settings' own Dark/Paper toggle (native-core's view)
  still writes localStorage; with the hub it should write appearance.scheme at device level.
- Tested since (d1e41db8, targeted 494: 493 pass, 1 skipped, 0 fail). Built: fd88ef27
  retired colours + "pin" wording; b623ddcc waiting.list / waiting.count / waiting.changed in
  js/needs.js (4 tests); 41f9b14d context.report (js/context-report.js, 3 tests); 084036c1 the
  Glass mini pill on Now (js/glass-mini.js, 3 tests; no picture yet: needs sight.frame or a small
  viewer, asked cohesion). Chrome check done (testbox, 390/430/1280): now-glass-mini, now, places-sheet, chat-session, and the pill flows all ok.
- Old next list (done above): cohesion's waiting.list,
  context.report, connections.list, credential sheet, Glass mini-view (said yes, once on main);
  docs' tips.next wiring (said yes, once on main).
- app-design answered (589716e7): retired names and "pin" wording applied in fd88ef27 (not yet
  tested: testbox runs held until the integrator reports batch 4). Open: the chat header's toggles
  on the phone read at base size (a menu would be better, chat's call).
- Theme module is app-design's core/appearance (b756d128, next batch); native-core serves
  /theme.css?device= and /v1/theme on it (/v1/appearance/theme is an interim alias).

## Earlier (resumed after logout 3, 2026-09-27)
- ADR 0029 on the Deck, done (2026-09-27): cdf65f1 stream on follow() + vyred serves
  /core/resilience/*.js; 8436536 Idempotency-Key on writes; a593fda outbox for sends, answers,
  Discard, planner add/done (Gate Send with a passkey never queued); a86734c Reconnecting pill;
  step 5 snapshot cache for Now's needs and Agents. Skipped: Chats (already paints from its own
  localStorage snapshot, chat/index.js; not moved to cacheStore), Now's "working" rows (threads.get
  transcripts, not kept by design), planner.snooze and firing Done (not asked; attempt as before),
  agents.* writes. The saved stream cursor is written, not read at start: views load fresh state
  through tools, so a cold start follows from since=latest; the cursor rides with each snapshot.
  Tests on testbox: 212 targeted (deck/test, deck/js, deck/chat, core/resilience), 211 pass, 1
  skipped, 0 fail; test/daemon.test.js route tests 2/2; test/onboard.test.js 15/15.
- New scope from the lead: Direction A is the design of record (one app for web, iOS and Android,
  app-design's docs/design/one-app/DIRECTION.md). On iPhone the default is the installed web app,
  so web-app quality is the iPhone app. mobile leads the one-app code (ADR 0027); pwa owns the web
  platform: service worker, offline cache, web push, badges, passkeys, the iOS pitfalls. The bar:
  60 fps, tab switch under 100 ms, cold open under 1 s offline.
- Merged main ef51363 (a3ec177). Fixed: the SW kept none of Now's phone modules (a910ae9).
- A done (f925a73): core/push holds ask/draft/watch until 3 min after the last `push.seen`,
  drops them on ask.answered or gate.released/rejected/revised/failed, lesson off by default,
  planner rings always. ADR 0011 amended, reference regenerated.
- B done (4f48768): the Deck keeps a presence session after a passkey on gate.approve and the
  vault's sessionable tools (x-vyre-presence-keep), reuses it until it ends and says "Face ID
  covers sends until h:mm"; push.seen from pwa.js (show, hide with keepalive, first input after
  60 s); planner-ack shows a silent "Answered." under the tag then closes it (WebKit revokes a
  subscription whose pushes show nothing); app badge = the Needs count in the installed app.
- C done (d462fd6): fixed 100dvh shell, `--kb` keyboard inset (deck/js/keyboard.js), safe areas
  at every width, touch-action/callout, content-visibility on long lists, Send reads "Send" while
  covered. SW cache vyre-deck-7. Row swipes stay JS transforms (rAF, will-change only while
  dragged); a scroll-snap row is a proposal for the lead (needs a real-iPhone spike).
- Done since: c281be8 build-stamped sw.js (release lands on the next launch); a222fa4 passkey
  card copy (lead); deck/sw.js ignores /app/ (for the one app's own worker).
- Done since the queue: 49cefab tailnet findings 1-4 and 6 (5 skipped: no tool reads
  network.origins); 1cf2662 merged main 9efbddc (249/249 targeted); 0c2ee51 push.subscribed,
  push.test receipts + push.receipt -> push.delivered, push.seen standalone event (for `vyre
  phone add`); 501b0d1 /app/ serving + /app/sw.js + manifest. Pushed work/pwa.
- Since: c7f0582 merged main c8fb9aa (sent to the integrator for batch 3b); bf65f90 a sideways
  phone keeps the phone layout (PHONE_QUERY in deck/js/dom.js, lead's decision); 0abb70d the
  palette from generated deck/css/tokens.css (missing tokens listed for app-design); 39022ec the
  person-session sheet + Signed-in devices in Settings (against e2e's contract; wire to e2e's
  signIn/deck:person once 3b lands); 886a86e /pair for `vyre phone add --tailscale-only`, and
  push.seen carries device. 313/313 targeted.
- ORDER (lead, native-core refocus): (1) wire the person sheet to e2e's signIn once batch 3b
  lands (take pwa's api.js side over e2e's stopgap); (2) the Reconnecting pill and outbox are
  done (cdf65f1..459b181), waiting for a Chrome shots run on testbox after chat's (port 4795)
  and after the current HOLD, then send to the integrator for batch 4; (3) native-core's asks of
  the Deck shell for chat and settings: top customer. Parked in Next: mobile's precache.json is
  done on work/mobile 24e2091 (nothing needed from pwa until it lands); relay's device.paired.
- Pending on main: tokens from app-design 4b77ba51 (regenerate tokens.css, then drop the raw
  names graphite/carbon/raised/ash/stone/bone/signal*/beacon for roles, remove --recall* and
  --beacon-wash/--beacon-rule, --r-1..4 -> --radius-*, --signal-ink-text -> --primary-ink);
  chat 977198f/b27aa6f SHELL entries (reviewed); tailnet a7365a99 network.origins (Hosted row
  drawn, feature-detected); federation v2 (batch 4): /needs/<ask> falls back to the relayed
  ask.raised for a Mac-owned ask; platform ADR 0033 P4 slot seam (proposed deck/js/slots.js,
  /m/ network-only in the SW).
- api.js (lead, tonight): chat's reconnect fix 30a9f81 ships on main tonight; when merging main
  after it, resolve deck/js/api.js's event-stream section in pwa's favour (the resilience
  rewrite replaces it in batch 4; onResume f776e89 keeps chat's session view working); drop
  deck/chat/api-stream.test.js or retarget it to onResume (asked chat).
- Lead decisions: keep JS row swipes until mobile's iPhone spike; no merging other teams'
  branches, wait for main; pwa owns deck/sw.js (told chat and e2e).
- Waiting (old line): the lead on e2e 8ad92a73 and app-design 99820a16 reaching main (items 2 and 3);
  polish-cli on what /pair shows; mobile on precache.json.
- QUEUE (from teammates, 2026-09-27; testbox: targeted runs only, uptime < 8, no worlds or
  Chrome without asking the lead):
  1. DONE (see the commit "fix(deck): VyreDrive per-share access..."). Skipped the "Hosted app"
     row: no tool reads config network.origins (system.info does not carry it); it needs a
     field on a read tool from tailnet or names. Was: tailnet's UI findings (work/tailnet 23c7cda, deck/views/settings.js): per-share access +
     ro/rw switch (files.drive.access {name, mode} -> mount.step cmd), `unsafe` secrets warning
     per share, `--tty` on every HUMAN_ONLY command hint, no Glass for guests (GUEST_SAFE =
     threads.list), optional Network row "Hosted app" (network.origins), no Approve on an ask
     whose thread has source "mac".
  2. e2e person session (work/e2e 8ad92a73): 401 person_session_required -> "Sign in on this
     device for 30 days" sheet then retry (replaces e2e's stopgap in api.js, signIn exported);
     Settings list presence.person.sessions with Revoke (presence.person.revoke {id}); restyle
     /person/signin; call signIn() after the first passkey in onboarding. presence.since on
     items: "confirmed 12 min ago".
  3. tokens: app-design's scripts/gen-tokens --css (work/app-design 99820a16) -> deck
     tokens.css with --check; move the Deck palette to it; tell app-design the properties.
  4. mobile one-app spike (ADR 0027 on work/mobile 999ce4f): pwa owns the /app/ route in
     vyred, its SW (scope /app/, precache from apps/app/dist/precache.json), manifest, iOS shell,
     keyboard inset, push reuse, IndexedDB cache (use resilience's core/resilience/web.js
     cacheStore). Plan the push subscription move when /app/ becomes /.
  5. phone add checks (polish-cli, relay): push.subscribed event, push.delivered receipt,
     a Deck /pair screen. Proposal sent to polish-cli.
  6. relay (work/relay): Settings Devices from relay.devices.list, the device.paired notice on
     every surface ("Alex's iPhone was added, just now. Not you? Remove it"), device.moved.
  7. vault board shapes (work/vault-next 50012ae7) when the Deck vault board is built.
  8. resilience web.js (work/resilience 276f916): outbox for every send/answer, one quiet
     Reconnecting pill, open offline from cache.
  - Asked the lead to bring e2e, tailnet and app-design branches to main before 1 to 3.

- Person sessions (e2e's contract) and the /pair screen for `vyre phone add --tailscale-only`:
  see Done. Waiting on e2e's box side to try it for real.

## Doing (restart, 2026-09-28)
- Merged main 57dc12c3 into work/pwa (751 commits: server-side terminology rename to "server",
  native-core, the Agent SDK session default, teammates, vault-next, resilience, the glass-hotfix
  docker-api fix, etc.) -> c84dd17a. Clean, no conflicts. Targeted suite after the merge (407
  tests: `deck/chat/**`, `deck/js/*`, `core/context/*`) is 407/407 green.
- Verified cohesion's finding 6 (docs/work/cohesion.md, hand-over fdd3a2ac) for the phone: "the
  project picker (context.now-started sessions) is data-ready but the UI is unconfirmed shipped
  ... make this the first thing verified end-to-end." Read the whole path (not just pwa's own
  file):
  - deck/chat/newsession.js reads `context.now` and preselects a real project slug for a fresh
    session (falls back to "no folder" on an unknown/missing slug); covered by
    newsession.test.js's "with no project given, it starts in context.now's project" (passing).
  - deck/js/context-report.js (`placeOf`) correctly derives `{project, thread}` from every Deck
    and phone route, including `/chat/:project/:thread` and the project-less `/chat/thread/:id`,
    wired into app.js on every navigate/focus (surface `phone`|`deck`); context-report.test.js
    (4 tests) passing.
  - deck/chat/session.js additionally reports a second, independent surface (`chat`, with `view`
    and `cwd`) once per thread open, from the loaded thread's own project field rather than the
    URL. Two surfaces reporting the same moment is by design, not a race: core/context (main,
    already merged) keeps one record per `surface`+`device` and answers `context.now` with the
    newest value of each field by its own timestamp, so a stale surface can never outlive a
    fresher one's null. core/context/context.test.js's "report and now: fields merge per surface,
    the newest value of each field wins across surfaces" exercises exactly this multi-surface
    case (including a field going back to null) end to end against the real module. Ran it, and
    the whole core/context suite, after the merge: green.
  - Tried to also drive context.report/context.now myself as a raw script (a temp `vyre new`
    world, deck/test/world.js) to watch the phone's exact call sequence hit the real daemon: both
    the daemon-client and `vyre call` paths came back "denied: ... not available to mcp callers"
    even with an explicit caller string, because the daemon resolves caller identity from the
    real transport (a genuine Deck session, or a true CLI/module process), never from a claimed
    header -- consistent with the security team's caller-forgery hardening now on main. That is
    the right behaviour, not a bug in pwa's code, and it means a fully faithful raw-socket replay
    isn't the honest way to test this from outside; the in-module test above already covers the
    real race with a trusted caller.
  - Conclusion: the picker's data path is wired correctly end to end on both surfaces pwa owns,
    the exact stale-surface seam finding 6 named is covered by a real test against the real
    module (not a fake), and everything is green after today's 751-commit merge. Marking this
    verified; no code change was needed here. Told cohesion.
- Left over from the merge, not urgent: many test-only comments and world fixtures under
  deck/test/ still say "box" (mac-world.js, pwa-perf.test.js, settings-keys.test.js, ...). The
  binding rename (LOGOUT 6 TERMINOLOGY, 2026-09-27) retires "box" from user-facing text only and
  assigns docs to compile the per-owner rename list for 0.1.1; nothing pwa-facing (Settings copy,
  onboarding copy) says "box" today as far as this pass found. Flagged for the docs sweep rather
  than done here, to avoid touching shared fixtures other teams' tests import.
- native-core's budget 8 (reconnect catch-up): confirmed the backoff fix (c78b87c0) is in this
  sha and reran; native-core measured 1,679 ms (down from 1,529-3,240 ms) but still ~680 ms over
  the 1 s budget, via backoff alone since neither `online` nor `visibilitychange` fire in their
  harness (checked their test file before building anything, to avoid burning a rerun on the
  wrong fix). Lead gave pwa ownership of core/resilience/stream.js for this one change while
  resilience is paused: added a fast reachability probe (`fastReach()` in `down()`, every
  `fastProbeMs` while a backoff wait is pending, capped at `fastProbeFor` from the first failure)
  so a wait scheduled before the box comes back doesn't have to run out its full step. New
  core/resilience/stream.test.js (3 tests, synthetic transport). Noted in resilience's
  docs/work/resilience.md for their return. Next: push, ask native-core to rerun budget 8 on the
  new sha, send the numbers to reviewer-2. Budget 8 closed (native-core: 55-90 ms), reviewer-2
  signed off be3f5554, told the lead.
- Wrote up the real-iPhone keyboard check for the user ("The keyboard check" section above),
  6e80bcdd.
- SW version skew ("a release lands on the second launch"): checked, and it was already done
  (c281be82 + d310169b, well before this restart) — core/daemon/build.js stamps sw.js and
  app-sw.js with the running build's commit at serve time, both workers skipWaiting()+
  clients.claim(), and deck/js/app.js's controllerchange listener reloads at once if nobody has
  touched the page yet, or defers to the next time it is hidden otherwise, so a release never
  mixes old and new modules under someone's finger. core/daemon/build.test.js (3 tests) still
  green. Removed the stale Next bullet; nothing to build here.
- The /app/ -> / push migration (lead: mobile is paused and the actual flip isn't scheduled
  yet, so build the forward-compatible piece that's clearly pwa's rather than guess at mobile's
  client-side code in apps/app). Built:
  - Confirmed core/push already keys subscriptions by endpoint, not by device id or scope
    (push_devices.endpoint is UNIQUE, push.subscribe upserts ON CONFLICT(endpoint)), so the app's
    (scope /app/) and the Deck's (scope /) registrations of the *same browser* naturally collapse
    to one row once the app re-sends the same endpoint after the flip. Added a test that was
    missing: "push: devices are keyed by endpoint, so two subscriptions of the same push service
    upsert to one device, never two" (core/push/push.test.js), including push.unsubscribe by
    endpoint actually stopping delivery. No code change needed here, only the test.
  - core/config/index.js: new `app.root` config key, off by default (`app: { root: false }`),
    merged one level deep like glass/computers/hooks. Test:
    "config: app.root is off by default... and a user can turn it on" (config.test.js).
  - core/daemon/index.js route(): while `cfg.app.root` is false (today, always), /app/* behaves
    exactly as before. Once it flips, GET /app or /app/* becomes a 301 to the same path under /,
    query string kept (`/app/now?tab=chat` -> `/now?tab=chat`; bare `/app` and `/app/` -> `/`).
    Test: "app: with config app.root, /app/* is a 301 to the same path under / instead of serving
    the app" (core/daemon/app.test.js). This does NOT itself move "/" from the Deck to the app —
    that's a separate, bigger change (whatever serves "/" has to actually be the app) that mobile
    or the integrator makes when the flip really happens; flipping `app.root` alone today would
    just make /app/* redirect to a "/" that still answers as the Deck, which is why the flag
    defaults off and nothing currently sets it.
  - **What mobile's client-side cleanup will need, when it returns** (this is apps/app's code to
    write, not built here): at launch, after the flip, call
    `navigator.serviceWorker.getRegistrations()` (not just `getRegistration(SCOPE)`, since by then
    the app's own registration is at scope `/`) and look for one whose `.scope` still ends in
    `/app/` — a leftover from before the flip. If found: read its `pushManager.getSubscription()`
    (if any), call `push.unsubscribe({ endpoint: sub.endpoint })` (needs no device id — see the
    test above), `sub.unsubscribe()` on the browser side, then `registration.unregister()`. Do
    this once (a flag in localStorage, `vyre.push.appScopeCleaned` or similar, is enough) since
    `getRegistrations()` after the first successful cleanup will simply not find one anymore. No
    new permission prompt and no re-subscribe: the Deck's own registration at scope `/`, and its
    subscription, are untouched and keep receiving pushes exactly as before the flip — this is
    only cleaning up the app's now-redundant one. `apps/app/src/pwa/pwa.web.ts`'s `startPwa()`
    (or wherever the app's own boot runs once it owns `/`) is the natural place for this, next to
    where it already does `navigator.serviceWorker.register(SW, { scope: SCOPE })`.

## Doing (scan-avatar-to-pair, 2026-09-28)
Built pwa's half of the lead's new brief: scan your avatar to pair your phone. No Tailscale on
the phone, no typed codes — the Deck shows the person's avatar in a live code ring (a one-time
pairing ticket), the phone's camera reads it, and the box confirms with Touch ID. The ticket
mint/resolve and the ring's own visual belong to tailnet and app-design (see "Needs from
others"); this is the camera + decoder + redeem-flow half.

- **Ported and fixed the decoder for the FINAL Vyre code layout.** The lead's brief pointed at
  round5's prototype (`scratchpad/avatars/round5/`, still there for anyone who wants the original
  4-ring/1-bit-per-dot version): 14/17 of its own degradation-harness scenarios passed, all 3
  failures perspective (camera tilt). That decoder (`decode-core.js`) was built for round5's
  FIRST pass geometry, though — the lead's actual "beauty pass" direction the user liked
  (`vyrecode2.js`) is a different physical layout: 2 rings x 36 marks x 2 bits (four tick
  lengths) instead of 4 rings x 36 dots x 1 bit. Porting the decoder to that layout
  (`deck/vyrecode/decode-core2.js`) needed real fixes, found only by testing against real
  rendered pixels, not guessed at:
  1. A tick-length read (not a disk luminance average) per mark, quantized to the nearest of the
     renderer's own 4 lengths (8/15/22/29px).
  2. The two rings sit only 35px apart, and the longest tick (29px + its own round line-cap)
     reaches to within about 4px of the next ring's own anchor — which itself has a round cap
     that bleeds a couple more pixels inward. Reading a mark's own trailing pixels as
     "background" (round4/5's own trick) silently picks up the OTHER ring's ink there instead.
     Fixed by reading two independent reference points per mark (the anchor, always ink; a
     half-slot-rotated point at mid-radius, never ink from any mark) rather than the ends of one
     profile.
  3. A continuous camera-frame rotation isn't a multiple of the 10deg mark spacing, and each
     mark's read patch is only ~2px wide, so the old 2deg rotation search step left real gaps —
     confirmed directly: rot=37deg (an arbitrary test angle) decoded with 1 mark wrong; its
     rotStep=2 neighbour rot=38 decoded with 65/72 wrong. Dropped to 0.5deg.
  4. The confidence score used to rank candidates isn't trustworthy on its own (a wrong scale can
     land its background probe on a real neighbouring mark by chance and read as a falsely clean
     bimodal profile) — so `search()` no longer prunes to a top-K at all; the caller (the harness,
     or `deck/js/scan.js`) tries candidates in confidence order and keeps the first one that
     actually RS/CRC-validates, which is what decides real from spurious.
- **Added the perspective (tilt) correction the prototype scoped out.** Detects the tint disc's
  own outer edge along many rays (scanning inward from a known-background anchor near the frame
  edge, not "biggest jump anywhere" — the tint fill is a deliberately soft, low-contrast wash, so
  the strongest edge in a wide scan is usually a MARK's, not the disc's own), fits a general conic
  to those boundary points, and CALIBRATES a tilt angle + assumed camera distance together by
  grid-searching for whichever pair — applied via the closed-form inverse of CSS's own
  rotateX(theta)+perspective(f) projection — makes the boundary points land back on a circle of
  the code's own known radius with least variance. (A naive `theta = acos(axis ratio)` badly
  overestimates: a real 15deg tilt fit an ellipse whose axis ratio implied 53deg — the
  foreshortening from a finite, comparable-to-the-code-size focal length skews the shape well past
  pure cosine.) Ran at multiple candidate corrections plus identity; the caller keeps whichever
  actually decodes.
- **Measured the pass rate with a like-for-like harness** (`deck/vyrecode/test/harness.js`,
  ported from round5's own methodology: render → degrade with real CSS in real headless Chrome →
  screenshot → reload into a fresh canvas → decode against real `getImageData` → RS/CRC-validate
  in Node — nothing simulated), same 17-scenario matrix, against a plain test renderer
  (`test/render-fixture.js` — decode doesn't care about the person's face or palette, only the
  ring geometry, which must and does match `decode-core2.js`'s own constants exactly):
  **11/17**, up from 0/17 on the naive port. Passes: pristine, blur 2/4px, all 4 rotation cases
  (15/37/90/181deg — the fine rotation step's whole point), scale 80%, both noise levels, one
  blur+rotate+scale combo. Fails: blur 6px (exceeds the tick-length read's own noise margin at
  this ring geometry's tight tolerances); **scale 120% (not a decode bug — the tint disc's own
  radius already sits only 15px inside the 600px render frame by design, so scaling the whole
  code up clips real ink off-canvas before any decoder gets a look at it — round4's smaller max
  radius had more headroom here)**; perspective 15/30deg (the calibration helps directionally but
  that same 15px margin leaves very little genuine background to fit an ellipse to, especially
  once a tilt compresses it further); the two hardest stacked-degradation combos. Full numbers in
  `deck/vyrecode/test/harness.js`'s own run (not checked in as a snapshot — it's a live headless-
  Chrome measurement, re-run it rather than trust a stale number).
- **The camera side** (`deck/js/scan.js`): opens the back camera, grabs frames onto an offscreen
  canvas on a timer (NOT every frame — a full decode attempt is roughly 1-2s of JS work, a
  continuous 0-360deg x 9-scale search tried candidate-by-candidate; live 30fps would pin the main
  thread solid), tries candidates in confidence order and stops at the first RS/CRC-valid one.
  Flagged honestly as a follow-up, not solved here: this should move into a Worker, and a cheap
  localization pre-pass (find the disc's rough centre/radius first, so the search only refines
  near it) would cut the attempt cost by roughly the search space's own factor — round5's own
  NOTES.md scoped this same gap out from the start ("a solved problem... just not built here").
- **The redeem-flow UI**: `deck/views/pair-scan.js` (pure state machine: scanning → resolving →
  confirm → pairing → done/error, with worded refusals for expired/used/unrecognised tickets and
  a pairing denial — tested without any camera or DOM) and `deck/js/pair-scan.js` (the sheet:
  camera preview in a ring frame, "Pair with `<box>` (`<fingerprint>`)?" with an editable device
  name, before anything happens). Superseded once by reviewer's verdict on bdca618b (below) — the
  first version sent the raw ticket to a server tool and trusted a server-supplied fingerprint,
  both wrong; the current version is described in full in "Phone-side contract".

## Next
- Settings > Setup rows could rerun a step in place instead of naming `vyre up`.
- Step 6 Mac card: "Already on your tailnet" for an online Mac node.
- theme.colors: match docs' final shape.
- threads.unqueue once capsule-now ships it.
- Real iPhone check by the user, against the DIRECTION.md bar: steps written up in "The keyboard
  check" above (2026-09-28), asked for a screenshot or recording of anything that doesn't match.
- A phone turned sideways (over 760 wide) gets the desktop layout; decide whether the phone
  shell should follow the shorter side instead (`max-width: 760px` or `max-height: 500px`) — the
  keyboard check's step 6 asks the user to notice this too.
- Scan to pair: wire `pairScanSheet()` into an actual route/entry (a `/pair/scan` route or a Now
  card, once launch's Deck-side "Add your phone" screen exists to link from — right now this is
  built and tested standalone, not yet reachable by a person). Move `scan.js`'s decode loop into
  a Worker and add a localization pre-pass (see "Doing" above) — the current ~1-2s-per-attempt
  cost is real but not yet a live-scan-speed problem. `relay.pair.ticket.resolve`'s exact
  contract needs tailnet's sign-off (see "Needs from others") before this can be tried against a
  real box.

## Design A gaps closed
The Deck-wide components from Design A v1 (app-design's spec, docs/design/system/components on
their branch). app-design ticks these in the specs' Gaps lists after the merge.

| Component | Gap | Commit |
|---|---|---|
| Button | `.btn` is mono 12 caps: now Instrument Sans 13/18 600, sentence case (css/buttons.css) | 68b935df |
| Button | no secondary, outline, hold or busy; disabled was opacity 0.45 and primary disabled kept lime | 68b935df |
| Button | `.btn-ghost` ink `--text-2` and radius `--r-2`: now `--text` and `--radius-button` | 68b935df |
| Button | `.sb` / `.sb-primary` second system (min 46, opacity disabled): folded in at 44 and 54 | 68b935df |
| Icon button | `.ibtn` radius `--r-2`; no 44 size, no filled round, no busy | 68b935df |
| Status mark | no running ring, crossed circle or hollow done dot in `deck.css` (css/marks.css, js/status-mark.js) | 6a86462d |
| Status mark | relayed health dots used gold: now `--label` solid, and unknown is `--label` hollow | 6a86462d |
| Status mark | rail count was violet mono text: the Now count is the 18 badge (99+, "3 need you") | 6a86462d |
| Toast | two toasts (`.np-toast` on Now, `.vt-toast` in the vault): one js/toast.js + css/toast.css | 82685182 |
| Toast | no in-place variant: `showToast({ slot })` draws it (Now's rows still use the floating one) | 82685182 |
| Rail | 216 px text rows 34 tall at 14 px: now the 72 px icon rail, 60 by 50 places, icon 20 over a 12/16 label (js/rail.js) | 861a6d40 |
| Rail | order was Now, Projects, Memory, Agents, Chat, Vault, Settings; Planner and Devices missing: now the spec's order, Devices and Settings at the bottom with the avatar | 861a6d40 |
| Rail | the Now count sat at the row's end: the 18 badge now sits on the icon (top 4, right 8), `aria-hidden`, Now reads "Now, 5 need you" | 861a6d40 |
| Rail | brand in the top bar (`.brand`, 216 wide): now the home mark at the top of the rail, its dot `--beacon-dot` while anything needs you | 861a6d40 |
| Rail | no Cmd+1 to Cmd+9 place keys: now in rail order, Ctrl off a Mac, never while typing | 861a6d40 |
| Toast | shadow `--light-top` and words 15/20: now `--float`, base 13/18, phone read 17/24 | 82685182 |
| Phone shell | the avatar opened a Settings sheet: now the Places sheet (head row, six tiles, hint), a dialog named "Places"; the avatar is "Places and account" | 79124ccd |
| Phone shell | no pin-a-fourth-page: a held tile (600 ms, or Shift+F10 / the context menu key) joins the pager after Agents and the header, one at most, per device | 79124ccd |
| Phone shell | the header labels could shrink: they never shrink and scroll sideways when four do not fit | 79124ccd |
| Top bar | `.needs-pill` was a violet wash: no fill, its count is `--beacon-ink` text | fd88ef27 |
| Status mark | `.dot.recall` was gold: now `--text-2`; "From memory" is a source chip (1 px `--rule-strong`) | fd88ef27 |

Not closed here: the phone tab bar badge (this branch has no tab bar, the phone shell uses page
labels); the 10 s toast under a screen
reader (a page cannot tell one is on); Now's rows keep the floating toast rather than in place.
Chat and native-core draw their own marks: chat/session.js and chat/index.js (`dot signal` for
running), chat/nav.js (`agent-dot`), chat/gate-item.js (`dot beacon`, now 8 via the alias),
chat/term.js (`term-dot`), chat/chat.css (`.cv-state-*`, `.rail-sub .count`), views/agents.js
(`ag-dot`), glass/watch.js (`gl-live-dot`, `gl-over-dot`, `dot signal`).

## Needs from others
- app-design: tick the gaps in "Design A gaps closed" after the merge. One question: a hold
  button's hover fill is `--hover` and so is its growing fill; buttons.css grows it in `--rule`
  under the pointer so the hold still shows. Confirm or give the colour.
- tailnet or names: a read of config `network.origins` (a field on system.info or names.status)
  for the Settings > Network "Hosted app" row.
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
- tailnet: rebuilt the ticket redeem flow (2026-09-28) against reviewer's verdict on the first
  version (raw ticket over the wire, a server-supplied fingerprint, `relay.join`+`presence:true`
  — all three wrong; see reviewer's message for the exact findings). The new shape is written up
  in full below ("Phone-side contract"), including the exact resolve endpoint URL, request/
  response and MAC encoding this file ASSUMES — none of it is confirmed against your real
  mint/resolve implementation yet. Please read that section and correct anything that doesn't
  match; `deck/js/pair-ticket.js` is the one file that would need to change.
- tailnet: the resolve response's `handle` field (for the success screen's redirect to
  `<handle>.vyre.run`, team-lead's 2026-09-28 decision) is this file's own addition to the
  assumed shape — confirm it's really there, or say where the handle actually comes from.
- app-design: the FINAL ring geometry (2 rings x 36 marks x 2 bits, ticksSunburst tick lengths
  8/15/22/29px, RING_R = FACE_R+30/FACE_R+65) is now baked into `deck/vyrecode/decode-core2.js`
  as fixed constants (RINGS, PER_RING, RING_R, LEVELS) and mirrored in the test-only
  `test/render-fixture.js`. If the beauty pass's own numbers move at all (ring radii, tick
  lengths, the 35px ring gap that's already tight against the longest tick's own reach — see
  "Doing" above), decode-core2.js's constants need to move with them, or this decoder silently
  reads a different, wrong geometry. Worth a quick cross-check once your branch's vyrecode2.js is
  final.

## Changed contracts
- deck/onboard/index.html and deck/onboard/passkey/index.html link /css/buttons.css right after
  deck.css (the onboarding pages use .btn, which moved there), then /css/marks.css.
- push.seen: optional `device` (string, at most 40), echoed in the push.seen event payload only
  when sent. The Deck (js/pwa.js) sends localStorage "vyre.push.device" (polish-cli asked).
- Deck route /pair (a normal route; the SW serves index.html for it like any other).
- deck/js/api.js: `setPersonHandler(fn)`. call() hands `person_session_required` (never for
  presence.person.*) to fn; fn resolving retries the call exactly once, rejecting fails it. No
  handler: the error as before. js/person.js installs it (app.js). ON MERGE with e2e's stopgap
  (silent signIn() and retry on 401 in api.js, exporting signIn, firing "deck:person"): this
  handler replaces the stopgap's silent retry; keep e2e's signIn name, which person.js exports
  with the same meaning (it fires "deck:person" too). api.js also exports `endPerson()`.
- presence items: the Deck reads optional `presence.since` (ms) for "confirmed N min ago".
- /app/ serves apps/app/dist (SPA), /app/sw.js and /app/manifest.webmanifest are made by vyred
  from dist/precache.json (core/daemon/app.js, app-sw.js). /app is a 301 to /app/; a missing dist
  is 404 `no_app`; /app/_expo/static/* is immutable, the rest no-cache; a missing /app/_expo/ file
  is a 404, not the shell. The build must write dist/precache.json =
  {"build": "<id>", "files": ["/app/index.html", ...every hashed asset]}.
- deck/js/needs.js: a Mac session's ask or question (`source: "mac"`, `machine`, `node`, from
  threads.asks or threads.list) has the usual options and is answered with threads.answer
  `{ ..., machine }` (federation v2). Pre-v2 fallback: a refusal no_such_tool, unsupported,
  bad_input naming machine, or not_found on an item without node sets `macAnswers()` false for
  the page (need-rows.js holds it; window event "deck:mac-answers") and answer rejects with
  "Answer it on <mac>." (`elsewhere` set); need-rows.js elsewhere(n) is then the machine, else
  null. mac_offline and timeout reject with the box's error and the item stays. `needs.hear(e)`
  (app.js passes ask.raised/answered/cancelled) and `needs.find(id)` open a pushed ask by id.
- memory.relevant: tailnet:<login> callers may read without a room (was refused).
- system.info: adds owner { name } (onboard.person).
- GET /theme.css served by vyred from config theme.colors.
- onboard.status: detail.devices.peers [{name, dns, os, online, lastSeen}] (additive), parsePeers export.
- docs/JOURNEY.md step 6 describes pairing the Mac and Add to Home Screen.
- Tabs on the phone: Now, Projects, Chat, Find, Agents (Ask moved off the tab bar; /ask stays).
- api.js exports `reachable` and fires `deck:reach` on window. No tool or event changes.
- Now's first child on a phone may be the setup card (phone-setup.js).
- ADR 0029, step 1: GET /core/resilience/{backoff,sse,stream,outbox,web}.js served by vyred
  (core/daemon/index.js, text/javascript, no-cache, the Deck's CSP), and allowed on the onboarding
  loopback (core/onboard/loopback.js assetPath). Not /js/resilience/ as first planned: js/api.js
  imports ../../core/resilience/*.js, which is /core/resilience/ in a browser and the repo file in
  Node, so the Deck's tests import the same code. deck/sw.js SHELL keeps the five files.
- deck/js/api.js: the event stream is follow() over fetch; the onboarding session rides as the
  x-vyre-onboard header on the stream (was ?s=; loopback.js reads both). New window event
  `deck:stream` (detail: follow's state), exports `streamState`, `kick()`, `stopEvents()`.
- deck/js/api.js call(): opts `key` (Idempotency-Key header) and `write: true` (a fresh key);
  export `newKey()`. Reads send no key.
- deck/js/api.js: `queue(name, input, { presence, onWait })` (data or ApiError) and `queued()`
  ({data}|{error}) through the outbox; `hear(event)` hands an event to listeners by hand (tests;
  chat/session.test.js and chat/mac.test.js use it instead of a fake EventSource). Call sites in
  chat's (composer, ask-item, question, gate-item), find.js, projects.js and planner.js changed to
  them (the chat team's files: one-line swaps, same inputs). planner's drawPlanner deps take
  `write`. IndexedDB database "vyre-resilience", object store per host.
- The phone's offline line is the Reconnecting pill (js/reconnect.js), driven by `deck:stream`
  instead of `deck:reach` (which api.js still fires). pwa.test.js needed no wording change.
- deck/js/api.js `snapshot.get/set(key)` (cacheStore per host), deck/js/needs.js `restore()`
  (app.js calls it at start); needs.load() keeps its list when both reads are offline.
- New: `deck/vyrecode/{rs,payload,decode-core2}.js` (browser-safe: no Node-only imports — the
  scanner needs to run these client-side), `deck/js/scan.js` (camera + decode loop), 
  `deck/views/pair-scan.js` + `deck/js/pair-scan.js` (the redeem-flow state machine and its DOM
  sheet). Calls the PROPOSED `relay.pair.ticket.resolve` and the existing `relay.join` — see
  "Needs from others".

## Perf
- No timers or polls added. The offline line rechecks only on `online`, on becoming visible while
  shown, and on Retry. Pull to find uses passive touch listeners. The SW install fetches about 45
  small files once per version.
- Scan to pair: `deck/js/scan.js` throttles decode attempts to one in flight, spaced 350ms apart
  (not per video frame) — a single full decode attempt costs roughly 1-2s of JS work (a
  continuous 0-360deg x 9-scale rotation/perspective search). Flagged as a follow-up in "Next":
  move it to a Worker and add a cheap localization pre-pass before this is a live-scan-speed
  feature; it functions today, it just isn't fast.
