# mobile

Branch: work/mobile · Worktree: ../vyre-mobile · ADR 0018

## Scope

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
- iOS: runs in the simulator against the test world (6dc0d1a); next, move it to the PWA's
  structure as Android did (e76224b).
- Priority (lead, 27 Sep): the PWA (team pwa) ships first; native follows on the same API and
  design. Tabs change to Now / Projects / Chat / Find / Agents with pull-down to Find, matching
  the PWA; tokens from docs/design/TOKENS.md. Asked pwa where Files, Memory, Vault, Settings live.
- CI (team ci): heavy builds move to GitHub Actions once live. iOS: apps/ios/scripts/build.sh
  [test]; Android: ./apps/android/gradlew -p apps/android assembleDebug testDebugUnitTest.
  CI is live (27 Sep): push work/mobile or `gh workflow run ios.yml|android.yml --ref work/mobile`;
  the Mac is for simulator screenshots only. In repo text the server is "testbox".

How to run the phone against the test world (Mac, one emulator or simulator at a time):
- `VYRE_NO_DIALOGS=1 node apps/test/world.js 4801`
- iOS: simulator `vyre-mobile` (iPhone 17, iOS 26.5); install the build.sh app and launch with
  `-VyreTestBox http://127.0.0.1:4800`.
- Android: AVD `vyre-mobile` (android-34 google_apis arm64), headless
  (`emulator -avd vyre-mobile -no-window -no-audio -no-snapshot`). The device key needs a
  screen lock and a fingerprint: `adb shell locksettings set-pin 1111`, then the fingerprint
  enroll screen with `adb emu finger touch 1` repeated. Install the debug APK and start with
  `adb shell am start -n sh.vyre.app/.MainActivity -e sh.vyre.app.TEST_BOX http://10.0.2.2:4801`.

## Next
- Reply labels (user rule): the assistant's name (agents.list kind assistant, or system.info),
  else "Vyre"; agents by name; the user as "you"; never "claude".
- Screenshots of every screen on both platforms against the test world; perf numbers.
- apps/RELEASE.md: real-device installs, TestFlight and Play Store steps for the user.
- Share sheet in and out, Taildrop (tailnet team), widgets and Live Activities (later).

## Needs from others
- lead and user: the push relay for store builds. Options and a recommendation are in the ADR
  0018 addendum (a relay inside the name directory). Until then push works with the owner's own
  APNs/FCM keys in the Vault.
- phone-design: docs/design/phone.md. Visual and layout work on both apps is on hold until it
  lands (lead, 27 Sep). Function work continues.
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
