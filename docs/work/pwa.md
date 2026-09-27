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

## Doing (resumed after logout 3, 2026-09-27)
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

## Next
- The push subscription when /app/ becomes /: a subscription belongs to the service worker
  registration that made it, so the app's (scope /app/) and the Deck's (scope /) are two, and
  core/push keeps each by its endpoint. When the app takes /, vyred serves the app's worker at
  /sw.js with scope /, which replaces the Deck's registration in place: the browser keeps the
  registration, so the Deck's subscription survives and now reaches the app's push handler (same
  payload, and paths stop needing the /app prefix). The app then calls pushManager.getSubscription()
  at launch and, if the /app/ registration still exists, unsubscribes it, unregisters it and tells
  core/push to drop that endpoint, so one phone never rings twice. /app/* becomes a 301 to the same
  path under / for a release, so an installed /app/ home-screen icon still opens. Nothing is
  re-subscribed and the person is not asked for permission again.
- SW version skew: a release lands on the second launch; register sw.js with the build commit.
- Settings > Setup rows could rerun a step in place instead of naming `vyre up`.
- Step 6 Mac card: "Already on your tailnet" for an online Mac node.
- theme.colors: match docs' final shape.
- threads.unqueue once capsule-now ships it.
- Real iPhone check by the user, against the DIRECTION.md bar. Especially the keyboard: open a
  session, tap the composer, the transcript must not jump and the composer must sit on the keys;
  the Send sheet's fields; Find's box.
- A phone turned sideways (over 760 wide) gets the desktop layout; decide whether the phone
  shell should follow the shorter side instead (`max-width: 760px` or `max-height: 500px`).

## Design A gaps closed
The Deck-wide components from Design A v1 (app-design's spec, docs/design/system/components on
their branch). app-design ticks these in the specs' Gaps lists after the merge.

| Component | Gap | Commit |
|---|---|---|
| Button | `.btn` is mono 12 caps: now Instrument Sans 13/18 600, sentence case (css/buttons.css) | buttons |
| Button | no secondary, outline, hold or busy; disabled was opacity 0.45 and primary disabled kept lime | buttons |
| Button | `.btn-ghost` ink `--text-2` and radius `--r-2`: now `--text` and `--radius-button` | buttons |
| Button | `.sb` / `.sb-primary` second system (min 46, opacity disabled): folded in at 44 and 54 | buttons |
| Icon button | `.ibtn` radius `--r-2`; no 44 size, no filled round, no busy | buttons |
| Status mark | no running ring, crossed circle or hollow done dot in `deck.css` (css/marks.css, js/status-mark.js) | marks |
| Status mark | relayed health dots used gold: now `--label` solid, and unknown is `--label` hollow | marks |
| Status mark | rail count was violet mono text: the Now count is the 18 badge (99+, "3 need you") | marks |

## Needs from others
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

## Perf
- No timers or polls added. The offline line rechecks only on `online`, on becoming visible while
  shown, and on Retry. Pull to find uses passive touch listeners. The SW install fetches about 45
  small files once per version.
