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

## One app: Doing
- Plan the one-week spike with pwa (Now, a session, the approve swipe) and scaffold apps/app.

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
- `package.json`: the test script also runs `apps/test/*.test.js`.
