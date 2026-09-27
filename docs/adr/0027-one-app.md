---
title: "ADR 0027: One app for the phone, the box's web app and app.vyre.run"
summary: One Expo codebase builds the iPhone web app, the Android APK, the Deck the box serves and the hosted app at app.vyre.run, with a measured smoothness bar and a native iOS build as the fallback.
audience: builders
owner: docs
status: draft
---

# ADR 0027: One app for the phone, the box's web app and app.vyre.run

Status: proposed, 27 Sep 2026 · Workstream: mobile (`apps/app`) · Supersedes: the native
SwiftUI and Compose apps of ADR 0018 (paused, kept on work/mobile) · Builds on ADR 0004
(presence), ADR 0011 (web push), ADR 0024 (chat), ADR 0026 (relay), ADR 0029 (resilience),
ADR 0030 (sessions) · Design of record: `docs/design/one-app/` (Direction A, `tokens.json`)

## Context

ADR 0018 started two native apps, one in SwiftUI and one in Compose, beside the Deck on the web.
That is three clients of the same API, each redrawing Now, Chat, the approval sheet and the
Capsule, and each drifting from the others a little every week. Paseo, the closest product,
ships one Expo codebase to iOS, Android, the web and its desktop shell, and its users call it the
smoothest remote for coding agents. The user chose the same shape on 27 Sep 2026.

Two constraints shape the install path:

- **No Apple Developer account yet.** Without it an iPhone can run a native build signed with a
  free Apple ID for 7 days, with no push. A web app added to the Home Screen needs no account,
  never expires, and gets Web Push (iOS 16.4 and later).
- **The user's bar is "smooth".** A web app on iOS can miss it where WebKit differs from a native
  view: gestures, the keyboard, long lists, memory. So the bar is written as numbers below and
  measured on a real iPhone before the web app is committed to on iOS.

## Decision

**One Expo app (`apps/app`) builds every client: the web target is served by the box as its app
and hosted at app.vyre.run; Android ships the native build as an APK the box installs and
updates; iPhone installs the web app over Tailscale (the relay as fallback), and a native iOS
build of the same code is the fallback if the web app misses the smoothness bar in a one-week
spike on a real iPhone.**

### 1. One codebase, three targets

| Target | Built by | Reaches the box | Installed by |
|---|---|---|---|
| Web on the box | `expo export --platform web`, bundled into `vyre.tgz` | same origin, `https://vyre.<tailnet>.ts.net` | Add to Home Screen (iPhone), open in any browser (desktop) |
| Hosted web | the same export, one immutable folder per version | the relay (ADR 0026), end to end encrypted | app.vyre.run, when the phone has no Tailscale |
| Android | `expo prebuild` + Gradle in CI (`android.yml`), release-signed with the box's own key | Tailscale, else the relay | `vyre phone add --android --usb` (adb), then self-updates from the box |
| iOS native (fallback) | `expo prebuild` + Xcode in CI (`ios.yml`) | Tailscale, else the relay | free Apple ID now (7 days, no push), TestFlight once the $99 account exists |

Stack, as Paseo's: Expo 54 with expo-router, React Native Web, Reanimated and Gesture Handler,
zustand stores read only through selector hooks, lucide icons. `android/` and `ios/` are
generated (`expo prebuild`) and never committed. Platform differences live in file suffixes
(`.web.tsx`, `.native.tsx`, `.ios.tsx`); layout never branches on the platform, only on width
(one breakpoint at 720, then 1100 and 1400 from `tokens.json`).

The web target replaces the Deck by stages: it is served at `/app/` beside the Deck, and moves
to `/` when it covers every Deck page (a parity list in `docs/work/mobile.md`). The Deck's
pages that are not rebuilt yet open in the app as plain links, never as a webview.

### 2. What is shared, and with whom

- **Tokens.** `docs/design/one-app/tokens.json` is the one source. A generator writes
  `apps/app/src/theme/tokens.ts`, the Deck's `tokens.css` and the Capsule's `Theme.swift`; the
  generated files are never edited by hand. Attention is `beacon` (violet), and the teal
  alternative is one key.
- **The session core.** Chat owns `deck/chat/core/` (ESM, JSDoc, no DOM): the transcript model,
  tool detail, line diffs, command matching and the ask cards' state. The app imports it as it
  is. Anything the app needs there goes in through chat's contract, never as a copy.
- **The event model.** The app speaks ADR 0030's session events (`thread.turn`, `thread.text`,
  `thread.tool`, `thread.state`, `thread.queued`, `ask.raised`, `ask.answered`,
  `thread.finished`, `thread.stopped`) and calls `threads.send`, `threads.unqueue`,
  `threads.answer`, `threads.interrupt`. The provider is a chip on the session, never a separate
  screen. The app keeps no Claude-specific code.
- **Resilience.** The client follows ADR 0029's reference client: SSE with `id` and resume,
  an idempotency key on every write, and an outbox in IndexedDB (web) or SQLite (native) that
  replays on reconnect, so an approve or a send made offline is never lost.

### 3. The phone is a full client

Every tool the Deck calls, the app calls, subject to the same caller lists. The phone reaches the
box as a `tailnet` caller or a relay `device:<id>` caller (ADR 0026); both are people callers.
Presence follows ADR 0004 and the no-nagging rule: a proof only to pair, reveal a secret, or
send, post, pay or delete outside; one proof opens a 30-minute presence session.

- **Web targets** prove with a platform passkey bound to the box's origin (the box's own name on
  Tailscale, or the relay's pinned origin for app.vyre.run).
- **Native targets** prove with the `device` method: a P-256 key in the Secure Enclave or
  StrongBox behind the biometric prompt (ADR 0018, already on the box).

### 4. The hosted app at app.vyre.run

A hosted page that could change under the user would be a way into every box. So:

- app.vyre.run serves only immutable, content-addressed folders (`/v/<sha>/`), built by CI from
  a tagged release, with the manifest's hashes signed by the release key.
- The box names the version it trusts. The page first loads a tiny, fixed loader that asks the
  box (over the relay) for its version and the signed hashes, then loads only that folder with
  Subresource Integrity. A box on version X is never served app code from version Y.
- Nothing about a box, a session or a secret is stored on app.vyre.run. The relay only forwards
  sealed frames (ADR 0026).
- The Cloudflare plan is approved; the relay team deploys it, and this ADR adds no other hosting.

### 5. The smoothness bar

Measured on an iPhone 12 (iOS 18) and a Pixel 6a, installed app, direct over Tailscale. These
are acceptance criteria: a target does not ship while it misses one.

| Id | What | Bar |
|---|---|---|
| `scroll` | page swipe, list scroll, row swipe | 60 fps, under 1% dropped frames over a 10 s fling |
| `tabSwitch` | Now, Chats, Agents (mounted) | first content under 100 ms (p95) |
| `coldOpen` | Home Screen, offline | Needs you drawn from cache under 1 s (p95) |
| `warmResume` | back from the background | under 300 ms (p95) |
| `approve` | approve swipe | the row collapses on the frame the swipe commits (17 ms at 60 Hz), optimistic, outbox, Undo for 4 s |
| `keyboardJump` | the keyboard opens | 0 px jump in the transcript; the composer moves in the same frame |
| `streamGap` | a streaming reply | p95 gap between visible updates under 50 ms |
| `longTasks` | while streaming | no main-thread task over 50 ms |
| `terminalEcho` | the terminal, direct path | key to echo under 50 ms (p95) |
| (manual) | a long session | 2,000 turns scroll at 60 fps; a 1 h session under 300 MB with no WebKit reload |

How the design meets it is in `docs/design/one-app/DIRECTION.md` ("Smooth: the bar"): gestures
on the compositor (scroll-snap strips on the web, Reanimated on the UI thread natively), one fixed
shell with inner scrollers, one `visualViewport` inset for the keyboard, an inverted transcript,
paced streaming with `content-visibility`, virtualized lists above 100 rows, three mounted tabs
(an LRU, one when memory is low), the shell precached and the last Needs, Chats and Agents in
IndexedDB.

### 6. The perf harness

`apps/app/perf/meter.js` is a DOM-free frame meter: the web feeds it from `requestAnimationFrame`
(only while the `?perf=1` overlay is on and the page is visible, so it costs nothing otherwise),
native from Reanimated's `useFrameCallback` on the UI thread. It keeps bounded rings of frames,
named measures (`tab.switch`, `open.cold`, `open.warm`, `approve.collapse`, `term.echo`),
gaps (`stream`), values (`keyboard.jump` in px) and long tasks, and its `report()` returns a
verdict against `BAR`, the table above as data. The overlay (built in the spike) shows the live fps and dropped
frames and copies the report as JSON.

Numbers of record come from the real phones above. CI runs the web target in Chrome with a 4x
CPU throttle against `apps/test/world.js` as a regression guard only; it fails a build when a
measure regresses by more than 20% from the last green run, not against the phone bar.

### 7. The one-week spike

Before the web app is the iPhone default, one week builds the three hardest pieces as the web
target, with the perf overlay on, against the test world and then the user's box:

1. **Now**: Needs you from cache, live over SSE, three mounted tabs.
2. **A session**: an inverted, virtualized transcript with paced streaming, the composer and the
   keyboard, queue and unqueue.
3. **The approve swipe**: a scroll-snap row, the optimistic collapse, the outbox and Undo.

The user runs the report on a real iPhone. If every bar passes, the web app is the iPhone
default. If any misses and the design notes in section 5 cannot close it within the week, the
same code ships as the native iOS build (free Apple ID now, TestFlight later), and the web app
stays installed for push until APNs is available.

## Consequences

- One app to design, test and ship. The native SwiftUI and Compose code stays on work/mobile,
  unmerged, as reference for the device presence method and the push transports.
- The box grows a static folder (the web export, about 3 MB gzipped) in `vyre.tgz`.
- The Deck and the app coexist until parity; new Deck features land in the app first.
- iPhone users get push through Web Push only, until the Apple Developer account exists.
- The relay team owns app.vyre.run's hosting; the release pipeline owns the signed manifests.

## Alternatives considered

- **Keep native SwiftUI and Compose.** The smoothest ceiling, but three clients to keep in
  step, and no iPhone install without the $99 account.
- **The Deck as a PWA only.** No Android native features (share sheet, reliable push, haptics)
  and no path to a native iOS build if WebKit misses the bar.
- **Capacitor around the Deck.** One codebase, but the UI stays a web page inside a native shell
  on every platform, so the fallback would not be native where it matters.

## Open questions

- The Apple Developer account ($99/yr): not approved. It unlocks TestFlight, APNs and system
  autofill; nothing in this ADR depends on it.
- Violet or teal for attention: violet until the user says otherwise.
- The Android release key: kept in the box's vault; how it is backed up follows ADR 0028.
