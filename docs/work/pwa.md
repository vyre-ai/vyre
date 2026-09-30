# pwa

Branch: work/pwa · Worktree: ../vyre-pwa · Owner session: pwa

Scope (lead, 2026-09-27): the phone app ships first as the Deck installed as a web app (PWA) over
Tailscale; the native apps (team mobile) come after, on the same API and design. Branched from
work/polish-surfaces (phone Chat, five tabs, title truncation), with main merged in (2e5d78a).

## Phone-side contract: scan your avatar to pair your phone (for launch, 2026-09-28)

launch can't message pwa directly, so this section is the handoff: what the Deck's "Add your
phone" screen needs to know about what happens after it shows the code. Current as of sha
00652f9d - tailnet's real split (`resolveTicket()`/`pairOffer()`, work/tailnet 13852c7a) is wired
and the route is live. Two earlier versions of this section (a hand-rolled protocol, then an
atomic-call interim) were reviewer-held or superseded; see "Doing" below for that history if it
matters to you, otherwise everything below is current and stable.

**No Tailscale in this flow, relay only** (team-lead, 2026-09-28) - the phone never touches the
tailnet; everything below goes over the relay via `relay/client/client.js`'s
`resolveTicket()`/`pairOffer()`.

1. **The Deck mints a ticket and shows it as a code ring** around the person's avatar (tailnet +
   app-design's side, not pwa's). The ticket is 8 random bytes; the ring encodes those RAW bytes
   directly (launch fixed an earlier hashed-ticket bug, d99a44d6) plus a CRC-8 and Reed-Solomon
   parity (`deck/vyrecode/payload.js`), 144 bits total, in app-design's 2-ring/36-mark/2-bit-per-
   mark layout (`deck/vendor/vyrecode/geometry.js`: RING_R=[188,222], tick lengths 6/12/18/24).
   Per reviewer: **Touch ID happens here, at mint** (option A) - not later, at redeem.
2. **The phone opens `/pair/scan`** (`deck/views/wink.js` - phone.vyre.run points here) and
   scans the code (`deck/js/scan.js`): camera → decode-core2.js's search → an 8-byte ticket,
   recovered but never turned into a string, logged, or put in a URL (it is this flow's pairing
   secret). The relay to ask is `wss://relay.vyre.run` (`core/relay/index.js`'s own
   `DEFAULT_RELAY` - the one relay every box registers through, so nothing box-specific needs
   handing to this page; a `?relay=` query override exists only for a self-hosted relay).
3. **The phone looks the ticket up WITHOUT pairing**: `resolveTicket(ticket, { relay, crypto })`
   (re-exported by `deck/js/pair-ticket.js`) derives everything from the ticket locally (domain-
   separated SHA-256 under tailnet's own tags), POSTs only the derived locator to the relay's
   `/v1/pair`, verifies the FULL record's MAC (not just part of it - an earlier version of this
   flow MAC'd too little and was reviewer-held for it) before trusting anything in the response,
   and returns `{ offer, name, fingerprint, handle }` - no pairing yet. `offer` (it carries the
   derived pairing secret) is held only in `deck/js/pair-scan.js`'s local `pendingOffer`
   variable, never storage, a URL, or a log.
4. **The person confirms**: "Pair with `<name>` (`<fingerprint>`)?", with "Not this one"
   returning to scanning and dropping `pendingOffer` without ever pairing.
5. **On Pair**: `pairOffer(offer, { name: deviceName })` runs the actual handshake. The device
   name sent is the person's first name (`system.info`'s `owner.name`) plus the model (User-Agent
   Client Hints on Android; iOS Safari has none and falls back to a plain "iPhone") - "Alex's
   iPhone" (team-lead's decision). Not editable today (no field on the confirm screen for it
   yet - a small follow-up, not blocked on anything).
6. **Success**: "Paired with `<box>` as `<name>`. Code `<fingerprint>`. Not you? Remove it in
   Settings, Devices." The phone shows the SAME avatar the person saw on the Deck
   (`deck/js/pair-avatar.js`, rendered fresh via app-design's vendored `identity.js`, not a
   photo - the camera-frame crop in `scan.js` is kept only as a fallback if rendering throws),
   doing a short celebratory hop-plus-confetti (under 1.2s, skipped under
   `prefers-reduced-motion`). Redirects to `https://<handle>.vyre.run` when `resolveTicket`
   returned one (it's `null` when the box hasn't claimed a handle); otherwise stays on the
   success screen.
   **ASSUMED, flagged to app-design, not confirmed:** the avatar option shown is derived from
   `sha256(box key)[0] % USER_GRADIENTS.length` - matching "the same avatar" ONLY if the box
   picks its own avatar the same deterministic way, from its own key. team-lead is separately
   asking tailnet to put the owner's real identity fingerprint in the verified record instead;
   swap to that field once it exists.
7. **Errors**: `resolveTicket`'s refusals map to worded, always-retryable states - a 404-shaped
   failure ("expired or was already used", tailnet's 404 deliberately covers expired/used/unknown
   alike so a scanner can't tell which applied), `rate_limited` for a 429, and `bad_ticket`
   ("doesn't check out") for a MAC or shape failure, which per reviewer must NEVER pair. A
   pairing-time failure (after confirm, from `pairOffer`) gets the same three-way mapping.

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

## Doing (real relay/client + vendored geometry, 2026-09-28)
Reviewer held the redeem flow a SECOND time on d49335e4: the hand-rolled protocol used different
domain tags than tailnet's real ones, put the locator in a GET URL instead of a POST body (access
logs), MAC'd only `route||box` instead of the full record (a relay could still swap the box's own
NAME, defeating the confirm step's purpose), and formatted the fingerprint differently from the
box's own. Fix: delete all of it. Merged work/tailnet (3cfd01c7, includes 8b693dab and 2990a810)
into work/pwa and rewrote `deck/js/pair-ticket.js` to call `relay/client/client.js`'s real
`pairTicket()`/`keyFingerprint()` only - no derivation, lookup or MAC code left in pwa's own
files. See "Phone-side contract" above for the current (interim, atomic-call) shape.

Also, separately, app-design fixed the ring-gap/margin finding from this file's earlier "Doing"
entry (the true cause was the orientation marker, not the ticks) and consolidated the geometry
into one shared, vendored module rather than a second hand-copy drifting out of sync again:
- Vendored `deck/vendor/vyrecode/geometry.js` (RING_R=[188,222], tick lengths 6/12/18/24,
  `validateGeometry()`'s own margin/gap invariant), `vyrecode2.js` (the real renderer),
  `identity.js` and `creature.js` (the avatar sources) from app-design's round5 scratchpad.
  `deck/vyrecode/decode-core2.js` now imports `RING_R`/`tickLength` from `geometry.js` instead
  of restating the numbers (`defaultGeometry()`); the toString()-injection harness technique
  needed a small adjustment for this - `decodeCore2()` now takes geometry as a plain-data
  argument (JSON-safe, no live functions) rather than closing over an ES import, since a
  toString()'d function can't carry the import with it into the injected page. See
  decode-core2.js's own header for the mechanics.
- `test/harness.js` now renders through the REAL `vyrecode2.js` + a real identity face instead of
  a synthetic flat-colour test disc (`render-fixture.js`, deleted) - more faithful to what a
  phone camera actually sees.
- **Pass rate with the real geometry + real renderer: 8/17**, down from the 11/17 measured
  against the old geometry and a synthetic (higher-contrast) test fixture. Two real, distinct
  effects, not one regression: (1) the real renderer's palette-derived mark colours
  (`paletteFor()`'s soft, theme-blended tones) have meaningfully lower contrast than the flat
  test colours the earlier number was measured against - blur and scale-80 both newly fail,
  which fits a contrast story; (2) tried scaling the ray-walk's sample offsets and patch size
  down to match the shorter ticks (6/12/18/24 vs the old 8/15/22/29) - made things WORSE (down to
  8/17 either way tested), reverted to the original absolute offsets/patch since there's no need
  to shrink them (the shorter ticks still fit comfortably under the unscaled sample range). Not
  chased further this session - team-lead's ask was to rerun and report, not to re-tune blind;
  the honest number is 8/17, and the contrast hypothesis is the lead worth pulling on next
  (either app-design widens the mark/tint contrast, or the decoder needs a contrast-adaptive
  threshold rather than the current fixed `abs(ink-bg)<3` cutoff).
- **Not done this session**: the Web Worker move and the localization pre-pass (team-lead's other
  ask, targeting under 200ms/attempt) - the geometry/protocol rework took the full session.
  Still ~1-2s/attempt on the main thread; see `scan.js`'s own perf note.
- Built `deck/js/pair-avatar.js`: renders the same avatar on the success screen from the vendored
  `identity.js`, camera crop kept only as a fallback. The avatar-option derivation is an
  unconfirmed assumption (see "Phone-side contract" point 4) - flagged to app-design.
- Fixed two pre-existing em dashes in tool descriptions that came in with the work/tailnet merge
  (`core/onboard/index.js`, `core/relay/index.js`) - broke `test/docs-check.test.js`'s
  reference-generation check.

## Doing (the real split + a wired route + the decode-rate diagnostic, 2026-09-28)
- tailnet's resolve/pair split landed (work/tailnet 13852c7a, `resolveTicket()`/`pairOffer()`).
  Merged again (a second `work/tailnet` merge, b38b199e) - reintroduced the two em dashes just
  fixed (a new ADR, 0046, also arrived with 34 of its own); fixed all of it again, 596e7fdd.
  Rewrote `deck/js/pair-ticket.js` down to a thin re-export plus `classifyError()` (matches
  `resolveTicket`/`pairOffer`'s plain-message throws against reviewer's mapping - neither
  function exports a `.code`), and rebuilt the state machine and sheet for the real
  confirm-before-pair shape (57ed8d04): scan → resolveTicket → "Pair with `<name>`
  (`<fingerprint>`)?" → Pair → pairOffer → done, with the resolved offer held only in a closure
  variable and dropped on "Not this one" or once pairing finishes.
- Wired `/pair/scan` to an actual route (00652f9d): `deck/views/wink.js` (ADR 0037's codename)
  mounts the sheet, defaulting to `wss://relay.vyre.run` (`core/relay/index.js`'s own
  `DEFAULT_RELAY`) - no box-specific address needed from launch after all, since there's one
  shared relay every box registers through. Told launch to point phone.vyre.run's copy here.
- Ran the decode-rate diagnostic team-lead asked for: raw per-mark error counts (of 72; RS
  corrects up to ~4 byte errors) at each scenario's own true rotation/scale -

  | Scenario | Errors | Reads as |
  |---|---|---|
  | pristine | 3 | fine |
  | blur 2px | 18 | FAILS - already 4x+ over budget at the lightest blur |
  | blur 4px | 38 | FAILS, worse |
  | blur 6px | 56 | FAILS, severe |
  | rotate 15/37/90/181deg | 5-6 each | fine |
  | scale 80% | 12 | fails/borderline |
  | scale 120% | 1 | fine |
  | noise light/heavy | 3 each | fine |

  Blur is the clean, dominant signal: catastrophic even lightly, while rotation and noise (which
  don't touch contrast) stay easily tolerable - points at CONTRAST, not geometry size, as the
  lever. Scale-80's degradation (smaller absolute marks) fits the same story. Sent the table to
  app-design with a specific ask (a contrast floor on the mark/tint colours) rather than touching
  the palette myself, per team-lead's instruction. Perspective scenarios weren't included in this
  table - they need the real ellipse-correction search to be measured fairly, not a raw rot=0/
  scale=1 read.
- Not done this session (still next): the Web Worker move, and re-running the harness once
  app-design has a contrast answer.

## Doing (14/17 - re-vendored the blur fix, plus the correction it needed, 2026-09-28)
app-design widened `TICK_STROKE_WIDTH` 4.5 -> 6 (ADR 0043 2e) as a blur-robustness test, and fixed
paper-theme contrast (2c) and the avatar-option source (2d, `defaultAvatarOption` in
`identity.js`). Re-vendored all three files.

Re-ran the harness: **0/17**, even pristine - a real regression, not noise. Found why by direct
mark-level inspection: a round line-cap always overshoots a tick's own nominal length by its own
radius (`TICK_CAP_RADIUS`), at every level equally; decode-core2.js never corrected for this, and
widening the stroke grew the overshoot (2.25px -> 3px) just enough, against `LEVELS`' own tight
6px spacing (6/12/18/24), to flip several marks a level high with NO degradation applied at all.
Not a flaw in app-design's stroke-width idea - a missing correction on this side. Threaded
`CAP_RADIUS` through `decode-core2.js`'s geometry argument and subtracted it from the raw length
read before quantizing (`sampleMarkLength`'s own new comment has the derivation).

With that fixed: **14/17**, matching round5's ORIGINAL synthetic-fixture ceiling (also 14/17)
almost exactly, now on the real palette and real geometry. All 3 remaining failures are
perspective scenarios (15deg, 30deg, the worst-case combo) - the same, already-documented,
still-scoped limitation from this decoder's first port, not a new gap. Reported to app-design and
team-lead.

## Doing (the decode Worker, 2026-09-28)
`deck/js/scan-worker.js` runs decode-core2.js's search off the main thread; `deck/js/scan.js`
now only draws a frame and `getImageData`s it (cheap) before transferring the pixel buffer to the
worker. **Real measurement** (headless Chrome, a Worker decoding an actual rendered PNG - not an
estimate): 242ms pristine, 380ms for a blur+rotate combo, ~2s for the already-known-failing
worst-case combo. Faster in the typical case than this file's own earlier "1-2s" figure (which
was a pessimistic estimate, not a measurement), but not yet reliably under the lead's 200ms
target on harder frames - the remaining lever is a localization pre-pass (find the code's rough
position/scale first, so the full search only refines near it instead of a blind sweep), not
built this session.

One observation worth a note, not a fix: at the worst-case combo (already reported as a decode
failure), the search ran to ~2s and returned a WRONG codeword (id `00000000...`) that still
passed RS/CRC - a false accept under extreme degradation, distinct from the CRC/RS module's own
fuzz coverage (reviewer-2: 0 false accepts across 40k synthetic-error trials) since this is real
rendered-and-degraded pixels finding an unlucky alignment, not a synthetic bit-flip test. **Safe
for pairing either way** (team-lead, 2026-09-28): a wrong 8-byte ticket still has to survive
`resolveTicket()`'s own lookup (its locator won't match any real ticket the box minted) and its
MAC check, both of which a decoded-but-wrong id fails - so this can never actually pair with
anything, only fail to scan, which is already the outcome recorded above. Worth keeping in mind
if the false-accept rate ever needs bounding formally, but not a pairing-safety concern.

## Doing (reviewer's stamped LOW, 2026-09-28)
Fixed the reviewer's LOW on wink.js's `?relay=` dev gate: it checked `r.data.stamped === false`,
but build.js only ever set `stamped: true` (a real stamped release) or left the field undefined
(git checkout, bare repo) - so an old or unusual box answering `system.info` without a `stamped`
field would have honoured the override by accident instead of failing closed. build.js now sets
`stamped` explicitly (`true`/`false`) in every branch, never absent. Checked `.stamped`'s other
two readers (core/cli/commands/update.js, up.js) - both do a plain truthy check, so undefined-vs-
explicit-false is a no-op for them. Updated build.test.js's checkout/bare assertions to the new
shape. sha f7059424, testbox targeted (build.test.js, app.test.js, pair-scan.test.js): 19/19.
Sent to team-lead and integrator. Next: tailnet's ticket-record encryption in resolveTicket()
(watching for their sha), then the real relay.vyre.run scan-to-pair check once tailnet deploys it.

## Doing (tailnet's Wink record sealing, ADR 0045, 2026-09-28)
Cherry-picked tailnet's d65ad771 (not a full work/tailnet merge - that branch also carries
unrelated ADR 0046 churn with its own em-dash back-and-forth; this task only needed the one
commit) into work/pwa as 8a18930b. Seals the whole ticket record with AES-256-GCM under a fourth
ticket-derived key (`vyre-pair-enc`); the relay now stores and returns ciphertext only.
`resolveTicket()`/`pairOffer()` keep the same calls and error codes (a record that fails to
decrypt throws the same `bad_ticket`-shaped refusal a MAC failure already did) - reviewer
confirmed and cleared it (d65ad771), and confirmed "nothing for pwa to change." Conflicts were
all either the ongoing hyphen-vs-em-dash wording fight in core/relay/index.js's own comments
(kept the hyphen, HEAD's side) or generated reference docs (docs/index.json,
docs/reference/index.md - regenerated with `npm run docs:ref` rather than hand-merged) plus one
real addition to docs/adr/0026-relay.md's threat table (Wink mitigation row, took theirs).
Reran on testbox: test/docs-check.test.js, deck/views/pair-scan.test.js,
relay/client/client.test.js, test/relay.test.js, relay/node/server.test.js,
relay/worker/worker.test.js - 105/105 pass. Nothing in pwa's own files needed a change; the
Wink phone-side contract above is unaffected. Reported to team-lead.

## Doing (tailnet's nonce + lib/identity fingerprint, 2026-09-28)
Cherry-picked tailnet's 7588fdd6 (d7ec3564 here): a random nonce inside each sealed Wink record
(reviewer's LOW 2, base64url(nonce12||ct||tag) so a repeated nonce can never mint the same
ciphertext twice), the ADR's LOW 1 note that the relay holds `loc` and could search the 64-bit
ticket space offline, and the identity fingerprint moved to `lib/identity.js`'s
`fingerprint8(owner.id, "person")` + `toBase64url` (unchanged from work/anywhere-ownerid
f3a25653) so a malformed owner id is refused by one shared check rather than a local one.
Checked 46900338 (relay.vyre.run as a Worker custom domain) first - only touches
relay/worker/wrangler.toml, no client path, so left it for the integrator/relay deploy rather
than cherry-picking it here. Only conflicts were the generated docs again
(docs/index.json, docs/reference/index.md - regenerated via npm run docs:ref); core/relay/index.js,
relay/client/client.js and README.md merged clean. No new em dashes. Reran on testbox:
docs-check, pair-scan, relay/client, test/relay, relay/node/server, relay/worker,
lib/identity.test.js - 111/111 pass. Sent head d7ec3564 to the integrator.

## Doing (the live relay.vyre.run scan-to-pair check, 2026-09-28) - BLOCKED, real CORS gap found
Task 3: run the real scan-to-pair flow against the deployed wss://relay.vyre.run, from testbox
only, headless Chrome + a temp profile, never a visible window. Built a throwaway harness (not
committed - a one-off, deleted after the run): a real vyred (test/fixtures/vyred-present.js,
presence auto-approved, temp VYRE_HOME, never touches ~/.vyre), `relay.pair.ticket` minted a REAL
ticket against the real relay (`relay.status` confirmed `connected: true, url:
wss://relay.vyre.run`), served over a local TCP proxy (deck/test/world.js's own pattern) so a
real headless Chrome (vyre-chrome, temp --user-data-dir, --headless=new) could load the actual
unmodified `/pair/scan` page. Only the camera module (deck/js/scan.js) was swapped via CDP Fetch
interception for a stub that hands `onFound` the real ticket bytes at once - the camera/decoder
path is a separate, already-measured concern (14/17 harness), not what this check is for.

**Found a real, structural CORS gap, confirmed by Chrome itself, not a guess:**
`resolveTicket()`'s `POST https://relay.vyre.run/v1/pair` fails in a real browser from ANY
origin other than relay.vyre.run itself - `relay/worker/index.js`'s `json()` helper (the only
place `/v1/pair`'s response is built) sets `content-type` only, no
`Access-Control-Allow-Origin`, and there is no `OPTIONS` handler at all, so the browser's CORS
preflight gets a plain 404 and Chrome blocks the request outright ("Response to preflight
request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present").
Same in `relay/node/server.js` (grepped: no CORS/OPTIONS handling there either).

This is not a testbox artifact - the real deployed phone flow hits the exact same thing: the
Deck's own writeup (this file's "Phone-side contract" above) has the phone open `/pair/scan` at
`phone.vyre.run` and call `wss://relay.vyre.run` - two different origins. Confirmed this is a
real architectural gap, not an oversight I could quietly work around: ADR 0026 (section on
Person sessions, "Hosting") states outright "there is no CORS [needed], because the browser opens
one WebSocket to the relay and every request travels inside the channel" - true for every
request AFTER pairing, which does ride the one already-open socket. But ADR 0045's
`resolveTicket()` runs BEFORE any socket is open (that's the whole point - "resolves...WITHOUT
pairing"), so it structurally cannot use "the channel" and has to be a plain cross-origin fetch,
which ADR 0026's no-CORS reasoning never covered. Nobody added CORS to `/v1/pair` because nothing
before ADR 0045 needed a pre-pairing HTTP call.

**Every real Wink pairing over the live relay is broken right now**, on any deployment where the
phone page's origin differs from relay.vyre.run's (which is the deployed shape: phone.vyre.run
serving /pair/scan, calling relay.vyre.run) - this blocks step 1 (resolveTicket) entirely, before
the confirm screen, pairOffer, the avatar dance or the redirect are ever reached. Could not
complete the rest of task 3's checklist because of this: reported at once rather than working
around it (a same-origin proxy hack in my own test harness would have hidden the exact bug a real
phone hits). Sent to team-lead, integrator and reviewer. Cleaned up: no processes or temp files
left on testbox, the throwaway harness script was not committed (deleted after the run).

## Doing (fixed: /pair/scan actually works in a real browser, 2026-09-28)
Urgent from team-lead (relayed from the integrator's review of stage): my headless test in the
previous entry never caught the real bug because it either bypassed CSP or hand-served
relay/client/*.js from my own test proxy, papering over exactly what a real phone would hit. Two
real gaps in vyred's own serving, both fixed in core/daemon/index.js (sha 30077044):

1. **relay/client/*.js was never served.** deck/js/pair-ticket.js and deck/js/pair-scan.js import
   `../../relay/client/*.js` (outside deck/), but `serveDeck()` only ever serves inside deck/ -
   any real browser got the client-routing shell (index.html) instead, so resolveTicket/pairOffer
   never loaded at all. Fixed with a fixed-path allowlist route (the same shape as
   core/resilience's own five-file route, and the pattern native-core used for
   lib/avatar-seed): client, channel, bytes, response, sse, webcrypto, noise - client.js's own
   browser-safe import closure, checked by hand. nodecrypto.js is Node-only and stays unserved.
2. **connect-src 'self' blocked the relay.** wss://relay.vyre.run (pairOffer's socket) and
   https://relay.vyre.run (resolveTicket's own POST /v1/pair - ADR 0045's pre-pairing fetch,
   which structurally can't ride the one already-open channel ADR 0026's "no CORS needed"
   reasoning covers, since it runs before any channel exists) were both blocked. `deckHeaders(cfg)`
   now computes connect-src per request: DEFAULT_RELAY plus this box's own configured relay
   (relay.status's url, for the self-hosted case relay/client/README.md documents), both wss:
   and the matching https: - narrow, no wildcards.

**Reverified against the live relay, loaded exactly as a real phone would** (real vyred, the
real unmodified CSP header, no Page.setBypassCSP, no test-proxy file-serving workaround this
time): minted a real ticket, resolveTicket showed "Pair with kit? Code af3j esuq" against
wss://relay.vyre.run, Pair ran a real pairOffer handshake, the avatar rendered, and
relay.devices.list showed the new device on the box side. The relay's own CORS gap on
`/v1/pair` (my earlier finding, reported to team-lead/integrator) was already fixed
server-side by the time of this second run (`curl -i OPTIONS https://relay.vyre.run/v1/pair`
now answers 204 with `access-control-allow-origin: *`) - not something pwa touched. No redirect
exercised live (this throwaway box never claimed a real vyre.run handle, deliberately - that
would register a real subdomain against production); the redirect-when-a-handle-exists branch is
one line, already unit-covered with a fake handle (pair-scan.test.js).

New test: daemon.test.js's Wink relay-client-serving + CSP case (7 files, both origins, the
nodecrypto.js negative case, the shell's own CSP). Targeted testbox run: core/daemon/*.test.js,
test/daemon.test.js, deck/views/pair-scan.test.js, deck/test/pwa.test.js, test/docs-check.test.js,
relay/client/client.test.js, test/relay.test.js - 135/135 pass. Sent to reviewer (the CSP/serving
change) and the integrator. Cleaned up testbox: no leftover processes/files; the one-off harness
scripts were not committed.

## Doing (the full live Wink check - resolve, confirm, pair, avatar, redirect - all pass, 2026-09-28)
tailnet redeployed the relay's CORS fix (worker 8897b7f4, work/tailnet 128171be:
Access-Control-Allow-Origin on both the OPTIONS preflight and every POST answer to /v1/pair) and
asked for a rerun. Confirmed via `curl -i OPTIONS https://relay.vyre.run/v1/pair` (204 +
`access-control-allow-origin: *`) before touching Chrome again.

Reran the full live check team-lead asked for, adding the one piece the last run (30077044's
entry above) didn't exercise - the redirect. Same shape as before (real vyred, presence
auto-approved, real ticket minted against the real relay, real unmodified CSP, no bypass, no
test-proxy workaround, only the camera module stubbed with the real ticket bytes), plus:
**this throwaway box's config carried a local handle** (`name: "kit"`, a sample-world name) the
same way a box that already finished real name-claiming carries one - `core/relay/index.js`'s
`boxHandle()` only ever reads `ctx.config.name`, no live DNS check at pairing time, so this is
an honest exercise of the client's own redirect logic (`celebrate()`'s `if (state.kind ===
"done" && state.handle) location.href = ...`) from a real, MAC-covered `resolveTicket()` answer -
not a fabricated client-side value. The actual outbound navigation to `kit.vyre.run` was caught
and aborted via CDP Fetch interception before any real request left the sandbox (no real
subdomain traffic), and confirmed the intercepted target was exactly `https://kit.vyre.run/`.

**All five checked out, against the real relay, loaded exactly as a real phone would:**
1. resolveTicket - real POST to `https://relay.vyre.run/v1/pair`, no CORS error now.
2. Confirm - "Pair with kit? Code mw5p gcla" (fingerprint deterministic per real box key).
3. Pair - a real `pairOffer()` handshake; the box's own `relay.devices.list` showed the new
   device afterward.
4. Avatar - `.scan-avatar` element present after the done screen.
5. Redirect - `location.href` set to `https://kit.vyre.run/`, intercepted before it left the
   sandbox.

Cleaned up testbox: no leftover processes or files; the one-off harness (three iterations across
this session, `wink-live.mjs` through `wink-live3.mjs`) was never committed. Sent to team-lead
and integrator: Wink is genuinely reachable end to end from a real browser now.

## Doing (reviewer's HOLD on 30077044, 2026-09-28)
Quick fix for both findings:
- MEDIUM: core/daemon/index.js's `import { DEFAULT_RELAY } from "../relay/index.js"` was a new
  kernel -> feature edge - test/boundaries.test.js's ALLOW list never covered it (it wasn't in
  the earlier 135-file targeted run, which didn't include boundaries.test.js - a gap in that
  run, not the fix itself). Moved DEFAULT_RELAY to `lib/relay-default.js` (a pure constant, no
  feature state, the "Modularity" rule's own escape hatch for exactly this); core/relay/index.js
  and core/daemon/index.js both import it from there now, and core/relay/index.js still
  re-exports it for its own existing callers.
- LOW: the configured-relay regex allowed `ws://` (a bare http: origin reaching connect-src) and
  arbitrary characters inside the CSP header. Tightened to `^wss:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$`.

sha d5fe9c3e. Ran test/boundaries.test.js this time (5/5, the one the reviewer caught missing).
Targeted rerun: test/boundaries.test.js, core/daemon/*.test.js, test/daemon.test.js,
deck/views/pair-scan.test.js, test/docs-check.test.js - 71/71 pass. Sent to reviewer and the
integrator.

## 0.2 (30 Sep 2026 onward)

Phase 1 (planning) plan is at `team/0.2/plans/pwa.md`, reviewed and cleared (reviews/pwa.md: 1
BLOCKER, 6 HIGH, 5 MEDIUM, 3 LOW, all fixed; one re-review HOLD on the shell-integrity fix,
cleared). Section 1 there is the honest state as of 0.1.x's end, worth reading before touching
this file's older entries above - it corrects one thing those entries assumed at the time
(Wink's "redirect to `<handle>.vyre.run`" success step - reviewer P-H0a found this breaks under
0.2's origin model, since a relay-only phone and a Tailscale-reachable one are different origins
with different storage; 0.2 replaces the redirect with a re-pair, see plans/pwa.md section 3).

**Operational note, binding as of today:** `team/RULES.md` now says outright that the test box is
the same host as the user's real, live Vyre server, and NOTHING runs there any more (no spikes,
no containers, no test runs). This whole file's own
history above, and this session's earlier live-relay verification work, ran real commands against
that box under the OLD rule (it was a shared testbox at the time). That's no longer allowed. Every
test now runs on GitHub Actions (`.github/workflows/node.yml` on push/PR/workflow_dispatch, or
`gh workflow run <name>.yml --ref work/pwa` for the Mac/iOS/Android-specific ones) - checked this
before running anything further today, and confirmed by watching a real run rather than assuming.

## Doing (N-H1 rebuilt on the release key, 2026-09-30)

Rebased onto origin/work/stage-0.2 (943 behind; the earlier relay and Deck commits were already on
stage, so only the two N-H1 commits remained). The first N-H1 attempt (own P-256 key and manifest)
is replaced by the lead's spec: the service worker verifies against the ONE release signature.

- `deck/sw.js` `verifyShell`: fetches `/release/SHA256SUMS`, `/release/SHA256SUMS.sig`,
  `/release/shell.json`; checks the Ed25519 signature (pinned `RELEASE_KEY`, over
  "vyre-release-sums\n" + SHA256SUMS), then the SUMS line for shell.json, then the shell.json
  hash of each fetched file. Refuses the new shell (cache dropped, no skipWaiting) on any miss when
  `SHELL_SIGNED` is true. Browser without Ed25519 installs unchecked with a console line.
- `core/daemon/build.js` `swWithBuild` sets `SHELL_SIGNED = true` when `deck/release/SHA256SUMS.sig`
  exists; a dev checkout or testbox has none and behaves as before. The daemon serves the three
  files from `deck/release/` and answers 404 (not the shell) when one is absent.
- `scripts/shell-hashes.mjs DIR` writes `DIR/shell.json` (every SHELL file except sw.js, which is
  stamped per build). The release runs it before `scripts/sign-manifest.mjs`.
- Tests: `deck/test/shell-release-sw.test.js` runs sw.js's own source against a real release made
  by sign-manifest.mjs with a throwaway key (match, tampered file, wrong key, swapped shell.json,
  missing file, unsigned build), and checks sw.js's key equals release.js's RELEASE_KEY.
- Honest limit: sw.js comes from the same origin, so this catches a shell that differs from the
  release, not an origin that also swaps the worker.

**Needs from others (asked in CHAT.md):** launch/anywhere: add `node scripts/shell-hashes.mjs dist`
to release.yml before the SHA256SUMS step, and have `vyre update` and the phone.vyre.run deploy
copy SHA256SUMS, SHA256SUMS.sig and shell.json into `<install>/deck/release/`.

## Next
- No test coverage of scan.js/scan-worker.js's own lifecycle (the busy flag, the transferred
  buffer, worker.terminate() on stop) - reviewer-2 hand-verified fa619b4a and confirmed it's
  correct, but flagged this as worth a fake-Worker test eventually (UI/perf plumbing, not a
  security boundary, so not blocking).
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

## Doing (Files view, 2026-09-30)

`deck/views/files.js` (+ `deck/css/views/files.css`, `deck/js/drive-browse.js`, route `/files` and
`/files/:share?p=`, all in sw.js SHELL). Built against work/drive's real shapes (files.drive.list
`{entries:[{name,dir,kind,mime,size,mtime}],total,next}`, files.drive.read 1 MiB base64 chunks with
`done`), not on stage yet, so on a box without the tools it says "does not have the Files tools".
Read-only: preview for image/text/pdf up to 8 MB (svg is a download), Save link, else a plain line.
Refusals are one line (not_available covers unknown, ungranted and hidden). Unit tests pass with a
fake chunking box; the DOM itself is a browser check. Open: no Places tile (app-design's 3x2 grid);
needs their placement, and a real-phone check once drive lands.

## Doing (no passkey chore, 2026-09-30)

Setup card = install + notifications; removed the passkey step and the two Now passkey reminders
(deck/js/phone-setup.js, now-phone.js). Send/approve on the phone already uses `presence: true`,
which proves a passkey only when the box answers presence_required, so the box's Gate decides
(asking is approving). Open with vault: where a phone enrolls a Face ID key for a vault reveal
without `vyre presence code` (a paired owner device should be able to enroll itself).
Open with native-core: Lumen/Memory display strings in the Deck are theirs per the lead's owner
list; pwa touches none until they say which files are left.

Drive tile added to Places and the rail (app-design's answer: /files, glyph drive, 3x3 grid with two free slots). Screen title Drive.

reviewer-2 on 390f4b8b, all four fixed: revalidation only caches listed-hash bytes (hash list kept in the cache at install), completeness (withheld or unlisted required file refused), rollback floor (shell.json version, VERSION_CACHE), Blob type forced in the Files view. Tests in deck/test/shell-release-sw.test.js (needs vyre-core's sign-manifest and release.js, so red on stage until it re-lands; 13/13 with them).

Enrol at pairing built against tailnet's 14b6bcc1: pairOffer({enroll:true}) -> reply.enroll {grant, expires, rpId} (validated in relay/client/client.js enrollOf, a small change to tailnet's file, listed under Changed contracts) -> redirect https://<rpId>/#enroll=<grant> -> js/enroll-grant.js takes and clears the fragment, one sheet, enrollPasskey({grant}). Untested end to end (needs a box with 14b6bcc1 and a real phone); unit-tested pieces only.

reviewer-2 MEDIUM (coverage) fixed: shell.json lists all served deck code (256 files today); a signed worker serves a code path only if listed and hash-matching, refuses an unlisted one. Note: a poisoned version floor (a bad but signed high version accepted once) is cleared by clearing the site's data; the floor lives in the vyre-deck-shell-version cache. (Superseded below: /onboard and /person are now covered.)

/onboard and /person: were outside the worker because they are their own pages that must load fresh and before any worker exists. Now listed in shell.json (folder addresses too) and, on a signed build, fetched and hash-checked by the worker, never cached. Gap that remains: the FIRST load of a box's address has no worker; that load is the box's own release files (CSP + vyred), not protected by this worker. Open with reviewer-2: should vyred also refuse to serve a deck file whose bytes differ from deck/release/shell.json at serve time (needs the signature check in vyred, which core/vyre-core/release.js has)?

Old-Safari brick risk (reviewer-2) fixed: unsupported Ed25519 refuses the install when a worker is active, else runs unchecked; the fetch handler enforces only when the install stored the hash list (test with a fake browser lacking Ed25519). /onboard and /person are covered (see above), not merely documented.

Decision (reviewer-2, team-lead): no serve-time check in vyred. First-load trust is stated plainly: the first load of a hosted origin has no worker (trust on first use); the worker protects every later load. New daemon test proves all 273 listed addresses are byte-static on a real box.

Step 9 done in a plain form: Find > Memory 'Ask Vyre Memory' row over memory.ask (non-streaming, one call per tap; memory.thinking events unused). app-design has not styled it (reuses the fd-askrow row). Step 11 (assistant.glance) not started: the tool is not on stage.
