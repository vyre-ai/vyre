# mobile

Branch: work/mobile · Worktree: ../vyre-mobile · ADR 0027 (one app), ADR 0018 (native, paused)

## Pivot (27 Sep 2026, user decision)

ONE Expo app (`apps/app`) for the iPhone web app, the Android APK, the box-served app and the
hosted app.vyre.run. Design of record: Direction A (inbox first), work/app-design
`docs/design/one-app/` (DIRECTION.md, tokens.json), canvas
https://claude.ai/artifact/Ap7uKGmbiEs4wM44iSyi1X. No Apple Developer account: iPhone = the
installed web app over Tailscale (relay fallback); Android = APK over adb from `vyre phone add`,
self-updating from the box; native iOS build only if the web app misses the bar in the one-week
spike. Agent SDK sessions (ADR 0030) are the default: the app speaks their event model and
imports chat's DOM-free core (deck/chat/core/). GitHub is flaky: retry pushes, keep WIP local.
The native SwiftUI/Compose code below is PAUSED and stays on this branch as reference.

## One app: Done
- ADR 0027 docs/adr/0027-one-app.md (draft, in the nav, claimed in docs/work/README.md):
  targets, what is shared, the hosted app's signed pinned versions, the smoothness bar as
  acceptance criteria, the perf harness, the one-week spike.
- apps/app/perf/meter.js + meter.test.js (19 tests) + README.md: the frame meter and `BAR`.
- docs: ADR 0018 front matter (status paused) and nav; reference regenerated (tailnet callers). 170/170 targeted tests on testbox (meter, docs-*, presence, gate, push, floor, mobile-tailnet, apps world).
- Merged main at ef51363 (a51bdcc): kept `tailnet` in the new callers (gate, switchboard, push),
  `device` in METHODS and in the presence session description; deck/test/world.js keeps its
  exports with main's alex-beside-home, CHAT_DEMO and WebSocket pass-through.

- Merged local work/app-design (2e205af): docs/design/one-app/ with tokens.json.
- scripts/gen-tokens -> apps/app/src/theme/tokens.ts (violet beacon, teal as attentionAlt), test.
- Answered pwa (apps/app, export served at /app/ with its own SW scope; pwa owns the SW and the
  /app/ route) and ci (app.yml: own lockfile in apps/app, plain prebuild+gradle, no EAS; a
  headless Chrome perf job reading window.__vyrePerf.report() as a regression guard).

- apps/app scaffold: expo export -p web OK (2.0 MB, JS 476 KB gz), tsc clean, 29 app tests.
  Native fetch cannot stream: the spike needs a native SSE transport. No idempotency header on
  the box yet (ADR 0029 owns it; resilience).

- Resilience client and person session in apps/app (see CHANGELOG); ADR 0027 sections 2, 3a
  (auth), 3b (alarms). Merged work/resilience with main 15e82dd (ab4e1db6). App: tsc clean,
  44/44 tests; root on testbox 188 pass before the zustand skip fix, then apps/app + docs 60
  pass, 3 skipped (they need the app's packages; CI app.yml runs them).
- The presence-keep response header is not read by the web client (web.js caller cannot see
  headers); the app takes presence.session.open's body instead.

- Native signer (modules/vyre-signer) + person.native.ts; Android debug APK builds (arm64, 55.5
  MB, 10 min under the build lock); iOS Swift not compiled yet. 53/53 app tests. Merged
  work/capsule-pro-tokens (gen-tokens writes the Capsule's Swift too).
- BLOCKED on e2e: presence.person.start refuses a `vyre://` return (needs the app scheme allowed,
  or https App Links / universal links); the box ignores the `human` key and `x-vyre-human`
  (human prompt is off until e2e maps it to presence).

- Spike screens built (web first): Now, approve swipe, session, ?perf=1 badge. Desktop headless
  Chrome sanity (not the bar): 60 fps 0% dropped, tab.switch p95 23 ms, open.cold 86 ms,
  approve.collapse 2.7 ms; keyboard.jump and stream gaps need a real phone and a streaming reply.
  70/70 app tests, tsc clean after merging work/chat 24855bac.
- Gaps: Undo holds the answer 4 s before the outbox (resilience outbox has no cancel(key));
  threads.unqueue/interrupt not on the box yet (Stop falls back to threads.stop); threads.get
  cannot page backwards; no presence proof from the web app yet (held sends open the item);
  native not run.

- Merged main c8fb9aa, work/resilience, work/relay fe94ed13, work/app-design (generator is
  theirs now). Relay paths + noble on native, vyre://pair, pwa hooks (precache.json, /app/sw.js,
  push from a tap, vyre:navigate, push.seen). core/apps `releases` module: APK routes + pure-JS
  v2/v3 signer, apksigner verify passes (11 tests, Mac). iOS compiles (sim + device, Xcode 26.6).
  83/83 app tests. Testbox runs queued for the integrator's open.

- releases is route-only through ctx.route (/v1/releases/android[?file=]); daemon untouched.
  Placeholder icon. Native person sign-in + device presence per e2e 57f32c4c; testIDs for ci.
  94/94 app tests, core/apps 11/11 (Mac).

- releases.sign tool for platform's vyre update (details sent to platform). Testbox set on
  cb4e988c: 251 tests, 246 pass, 0 fail, 5 skipped (app-package and apksigner tests; both pass on
  the Mac). Sent to the integrator for batch 4.
- Relay: keep direct first on native until relay's `prefer` mode exists (paths.js only probes
  paths ahead of the current one).

- PARKED trust gaps (lead, 27 Sep): relay queued denied-not-404, device.trusted event + close
  reason, webExpiryDays/trustedBy/trustedAt, name in the summary; trusted-by line hidden until the
  data exists; avatar = person's initial once onboard exposes onboard.person (box initial now);
  web passkey presence prompt. No new screens (lead): focus is the chat session screen on the
  native bar (native-core docs/design/native-bar.md) and the real-iPhone run.

- Session screen on the native bar (151/151 app tests, 554 KB gz). Desktop headless Chrome 4x
  throttle sanity: all pass except keystroke p95 16.5 ms (budget < 16, a frame is 16.7) and
  boxToScreen (no `t` on thread.text yet). Asked chat: plain-send row in the core, pace seed,
  threads.get since/limit returns the newest. Asked native-core: keystroke "within one frame"?,
  a server `t` and box clock.

- Resumed after LOGOUT 4 (27 Sep): merged main 7880dfa6 (3e502914; push PEOPLE keeps "tailnet").
  Design-system adoption: fonts bundled (Instrument Sans 400/600, JetBrains Mono 400; woff2 on the
  web, ttf embedded on native), src/theme/type.ts steps on every screen, one Button (five kinds,
  four heights) replacing hand-drawn buttons, Card/Tag/Banner/Avatar, StatusMark sizes from the spec
  (47fbb75c). Fixed apps/app/.gitignore, which dropped the local modules' native sources
  (vault-android, vyre-signer never reached git); vault-android = work/vault-next 725e4a41. The
  HUMAN_ONLY mirror gained presence.person.start. Perf flag kept per device + a web Settings row,
  because the Home Screen app opens /app/ with no query (ceaf1268). Root suite runs lib/**.
  test/mobile-tailnet.test.js updated for ADR 0032 (sign in as the person with the device key
  first) (2df02254). App 121/121, tsc clean; testbox 168/168 (push, docs-*, lib, mobile-tailnet,
  person, presence). Headless Chrome over CDP: renders, badge on with ?perf=1, kept on /app/,
  off after ?perf=0.

## One app: Doing
- The real-iPhone run: steps in "iPhone test steps" below, after tonight's deploy.
- Design-system adoption, remaining: vault TrustCard and the Rows AskCard still draw their own
  card box (move to <Card>); icons, icon button, key hint, tabs, sheet, settings row are "not
  built" in docs/design/system/README.md; waiting on app-design's per-team spec list for order.

## iPhone test steps (for the lead to hand the user)
1. iPhone: Tailscale on, same tailnet as the box.
2. Safari: open https://<box>/app/ . Share, Add to Home Screen, Add. Open Vyre from the Home Screen
   (the installed app has its own cookies and storage, separate from Safari: do everything below in it).
3. Settings (top right), Performance meter: tap it once. The page reloads and a small badge shows
   fps, dropped frames and a verdict. It stays on across launches until tapped again.
4. Sign in when the bar asks (passkey; if the box has none, the one-time code from
   `vyre presence code` on the box).
5. Now: let it load, switch tabs Now, Chats, Agents a few times, close and reopen the app once.
6. Open a session from Chats, type a short message, send it, let the reply stream, scroll up while it
   streams, then Stop once. Open the keyboard and close it twice.
7. Back on Now, swipe a waiting item to approve (or on a sample item if nothing waits).
8. Tap the badge: it copies the report as JSON. Paste it into a message to the lead.

## One app: Next
1. The spike plan with pwa; then scaffold `apps/app` (Expo 54, expo-router, RN Web, Reanimated,
   Gesture Handler, zustand), web export served at `/app/` by the box.
2. Tokens: a generator from tokens.json (coral gone, violet `beacon`) to tokens.ts, the Deck's
   tokens.css and Theme.swift (coordinate with deck-design, who owns the Deck CSS swap).
3. The spike: Now, a session (inverted virtualized transcript, paced streaming, composer and
   keyboard, queue/unqueue via threads.unqueue), the approve swipe; the `?perf=1` overlay.
4. Phone first-class parity list (every Deck page), then the Android build in CI and
   `vyre phone add --android --usb`.
5. work/mobile-presence: the device presence method as its own branch for relay (device:<id>).

## Native (ADR 0018, PAUSED)

### Scope

Owns `apps/ios/`, `apps/android/`, `apps/CONTRACT.md`, `apps/RELEASE.md`, `apps/test/`. Native
iPhone and Android apps for the Deck, Chat and the Capsule: Now (held drafts edited in place),
Chat (projects, sessions, the terminal mirrored, streaming, sending, the lease), a mobile Capsule
(one search box, ask the assistant, @agent, tell or watch a session, voice), Files, Agents,
Memory, Vault (reveal and copy only after presence on this device), Settings, and native push.

Small changes outside the scope, each through the owner's contract and listed below:
`core/presence` (a `device` method), `core/modules` (a `tailnet` callers entry), `core/push`
(native transports), `deck/onboard/device/` (the sign-in page the app opens).

## Plan

1. ADR 0018 and the client contract (`apps/CONTRACT.md`). Done.
2. Server side, in parallel with the apps: the `device` presence method and its tests; a
   `tailnet` entry in `callers` lists for the people-only tools; `deck/onboard/device/`;
   `apps/test/world.js`, a temp-home vyred with the fictional world behind a plain HTTP proxy the
   simulator and emulator reach.
3. iOS (SwiftUI, XcodeGen project, no packages) and Android (Compose, Gradle, OkHttp), each: API
   client + SSE reader + device-key presence, then Now, Chat, Capsule, then Agents, Memory, Vault,
   Files, Settings. Unit tests for the client pieces, then screenshots of every screen against the
   test world.
4. Native push: `core/push` APNs and FCM transports with a sealed path, the iOS service
   extension, the Android messaging service. Tested against a fake APNs/FCM server.
5. Release steps written down for the user (`apps/RELEASE.md`).

## Done
- ADR 0018, claimed in docs/work/README.md. `apps/CONTRACT.md` from the code on main before the mobile work.
- `device` presence method (a168aa6): a phone's P-256 key, enrolled with `presence.enroll
  {kind:"device", name, public_key, alg:-7}`, signs the Capsule's message with ES256. One code
  path and one nonce set for capsule and device. Offered only once enrolled, allowed on the box,
  opens `presence.session.open`. A migration widens `presence_keys.kind`. ADR 0004 addendum.
- `tailnet` callers entry (fad6f0f): `callerAllowed()` in the registry. Gate, `threads.answer`,
  push and the vault's reveal/copy/totp/session tools list it. `test/mobile-tailnet.test.js`
  proves a phone gets `presence_required` on `gate.approve` without a proof and sends with a
  device proof, through the daemon's router as the names listener calls it.
- `/onboard/device` (15c3a8a): the sign-in page the app opens in the authentication browser.
  Passkey first, the one-time code when the box has none; returns to `vyre://enrolled`.
- `apps/test/world.js` (fd0413c): the Deck world on a box, every request as alex's phone on the
  tailnet, fake Gate senders on 127.0.0.1 so approvals really send (to them), a fake claude,
  and `/__test/code|hold|ask|outbox`. `deck/test/world.js` now exports its pieces.

- Android: builds (assembleDebug, 28/28 JVM tests). First run, five tabs, Capsule,
  Files, Agents, Memory, Vault, Settings. Runs in the emulator against apps/test/world.js and
  enrolls with a one-time code (27 Sep 2026). Now's OPEN-label overlap fixed.
- apps/RELEASE.md: the owner's steps for real phones, TestFlight and Play.

## Doing
- The phone redesign (docs/design/phone.md on work/phone-design: B's shell, A's screens; latest
  09115fa violet attention, no red; 59bcbcf the Changes row), on both apps in section 14 order.
  - Android: step 1 shell 978abea, step 2 Now 0b7be19, both CI green. Next: the New agent sheet
    (data/NewAgent.kt, NewAgentTest.kt in progress), then step 3.
  - iOS: step 1 shell 704ba31 green, step 2 Now a54765b (CI was running at save). Next: the New
    agent sheet (Screens/NewAgentSheet.swift, VyreTests/PresenceRetryTests.swift in progress).
  - Screenshots of step 2 on both not taken yet: take them (one simulator, then one emulator,
    against apps/test/world.js), send to lead and phone-design.
- Subagents were stopped at save with WIP commits by path; read `git log --oneline -15`.

How to run the phone against the test world (Mac, one emulator or simulator at a time, shut it
down after):
- `VYRE_NO_DIALOGS=1 node apps/test/world.js 4800` (4801 for Android).
- iOS: download the CI artifact (`gh run download <ios run>`), simulator `vyre-mobile` (iPhone 17,
  iOS 26.5), install Vyre.app, launch with `-VyreTestBox http://127.0.0.1:4800`, `-VyreTab`.
- Android: AVD `vyre-mobile` headless (`emulator -avd vyre-mobile -no-window -no-audio
  -no-snapshot`), it has PIN 1111 and fingerprint 1 enrolled (`adb emu finger touch 1`); install
  the CI APK, start with `-e sh.vyre.app.TEST_BOX http://10.0.2.2:4801`.
- Builds: CI only (push work/mobile, or `gh workflow run ios.yml|android.yml --ref work/mobile`).

## Next
1. Step 2 screenshots; the New agent sheet on both (agents.create in apps/CONTRACT.md).
2. Step 3 the approval sheet, 4 Chat, 5 Find, 6 Agents, per phone.md.
3. Use chat's contracts (work/chat 10604b9, once merged): ask anchors (anchor.event, or thread +
   at; tool_use_id null for MCP) for Open session; questions (threads.asks kind question,
   answers map); "Always in <project>" only when ask.always_project, threads.answer
   {decision:"always", scope:"project"}; labels from system.info.assistant.name, null means Vyre.
4. Colours: attention is violet (one asset swap, the user may pick honey or teal), no red or
   system destructive styles; errors are text with a crossed circle and "failed"; destructive =
   outline with a 0.6 s hold. Measure text contrast on real screens in both themes.
5. phone.md e4a37f7: held, ask and question cards are neutral (panel, strong rule, no tint;
   attention only in the dot and label); drafts edit To, Subject and Body in place with only Send
   and Discard; buttons are primary, secondary or ghost; deleted diff lines are text-2 on
   del-wash. Coral is gone: violet through one token (Tone.attentionDark/Paper in
   apps/ios/Vyre/Design/Tokens.swift, Hex.attention/attentionPaper in apps/android/.../Tokens.kt).
6. Working needs a step total from the box for a determinate bar (gap, ask chat).
- Later: share sheet, Taildrop, widgets, Live Activities.

## Needs from others
- STANDING RULE (user, 27 Sep): Vyre must not nag. Face ID (device proof) only for pairing a new
  device, vault secrets, and sending, posting or paying outside; one Face ID covers about 30
  minutes. Creating or editing an agent needs NO Face ID: a person caller is enough. Keep the
  presence_required retry as a harmless fallback.
- daemon/onboard owner (via lead): `res.write(": open\n\n")` after flushHeaders in
  core/daemon/index.js stream(), so iOS sees the SSE stream open at once. Tried on work/mobile:
  it breaks test/onboard.test.js "unused link and an open page survive vyred restarting" (fetch
  failed), so it was reverted; the owner must look.
- lead and user: the push relay for store builds. Options and a recommendation are in the ADR
  0018 addendum (a relay inside the name directory). Until then push works with the owner's own
  APNs/FCM keys in the Vault.
- phone-design: the native apps approve with the device key, not a platform passkey (a store
  app cannot assert passkeys for every owner's box domain). Asked to amend phone.md sections 4-6.
- Open session anchor (phone.md section 15): threads.asks and gate.held rows need the transcript
  event or tool_use id. Until then Chat scrolls to the first item at or after `at`.
- planner (ADR 0025, work/planner): push kind "planner" with actions done/snooze and events
  planner.fired/acked. If the apps ring alarms locally, dedupe on the firing id and ack with
  planner.done/snooze {firing}. Nothing needed yet.
- link or tailnet: a way for the box to call the Mac (tailnet federation covers sessions; files
  later, left open by the lead) (box-to-Mac `link.remote`), so the phone
  sees the Mac's files and sessions. Without it the phone reaches the box only.
- link: a `files.put` (or the Glass ticketed upload as a tool), for share-sheet-in.
- security: review of the `device` presence method.
- switchboard: review of the push transports; a `thread.status` event would save a re-read.

## Changed contracts
- `core/presence/index.js`, `module.js` (security): method `device`, kind `device` in
  `presence.enroll` (enum and checks), migration 3 rebuilding `presence_keys` with the wider
  CHECK, `device` in `SESSION_FROM`. `docs/adr/0004-presence.md`: an addendum.
- `core/harness/floor.test.js` (harness): one more denied command, a `x-vyre-presence: device`
  header. `rules.js` is unchanged; its regex already covered it.
- `core/modules/index.js` (modules): new export `callerAllowed(callers, caller)`, used by
  `Registry.call` and `listTools`. `callerKind` is unchanged.
- `core/gate/index.js` (gate): `"tailnet"` added to the callers of `gate.get`, `gate.approve`,
  `gate.reject`, `gate.revise`.
- `core/switchboard/index.js` (switchboard): `"tailnet"` added to the callers of `threads.answer`.
- `core/push/index.js` (switchboard): `"tailnet"` added to `PEOPLE`, the callers of every `push.*`.
- `core/vault/tools/surfaces.js` (vault): `"tailnet"` added to the callers of `vault.session.open`,
  `vault.session.status`, `vault.reveal`, `vault.copy` (not `vault.fill.native`).
- `core/vault/index.js` (vault): `"tailnet"` added to the callers of `vault.totp`.
- `deck/onboard/device/` (deck): a new page, its own `index.html`.
- `deck/test/world.js` (deck): exports `buildHome`, `makeProjects` (now async) and `heldItems`;
  run directly it behaves as before.
- `package.json`: the test script also runs `apps/test/*.test.js` and `lib/**/*.test.js`.
- `lib/perf/` (new shared pure helper): the frame meter, used by apps/app and the Deck's native-bar harness.
