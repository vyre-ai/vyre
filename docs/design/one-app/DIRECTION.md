---
title: Vyre one app, the direction
summary: Three directions for one app on every device, the recommendation, the smoothness bar and the install path, for the user to decide before the full sheet.
audience: builders
owner: mobile
status: draft
---

# Vyre one app: the direction

Decided 27 Sep 2026: the user chose A (inbox first) as the design of record. Violet stays the
working attention colour until the user says otherwise.

## The problem Paseo does not have

Paseo is a remote for coding agents: one kind of work (a session), one kind of question (allow
this tool?). Vyre has five kinds of work (coding sessions, operating agents that send and pay,
computers in Glass, the planner, the vault) reaching you on four surfaces (phone, desktop, the
Capsule, the CLI) over two networks (Tailscale, the relay). If each kind gets its own screen and
its own alerts, Vyre becomes five apps in one frame. The design job is to make them one thing.

## Three directions

**A. Inbox first (recommended).** Home is Needs you: one list of everything waiting on you, of
every kind, oldest first, answered in place (swipe on the phone, A and D on the desktop, a key in
the Capsule, `vyre allow 2` in the CLI). Everything else is a place you go to: Chat, Agents, <!-- terms: ignore -->
Planner, Vault, Devices. Sessions look like Paseo's inside Chat.
- For: matches Vyre's promise (agents work, you decide); the same row everywhere; the phone is
  useful in ten seconds; the Gate, questions, grants and alarms share one habit.
- Against: a coder who lives in one session has one more hop (fixed: ⌘1 to 9, and the app reopens
  where you were unless something waits).

**B. Workspace first (Paseo's shape).** Home is a sidebar of sessions and agents grouped by
status, a session open beside it. Needs you is a filter.
- For: best for long coding days; proven by Paseo.
- Against: operating work (a draft to send, a sign-in grant, an alarm) has no session to live in,
  so it becomes badges on rows you have to open. The planner and vault feel bolted on.

**C. Assistant first.** Home is one conversation with juno. Everything arrives as cards in that
thread (asks, drafts, codes, alarms), and you ask for the rest.
- For: calm, voice-friendly, great on the phone and in the Capsule.
- Against: dense work (a diff, a vault list, ten agents) is poor as a chat; history gets long; it
  hides what is running.

**Recommendation: A, borrowing from both.** B's workspace shell becomes the Chat place on the
desktop (list, transcript, side panel, a real terminal); C's single entry becomes the Capsule and
⌘K on every surface ("Ask juno, find, or run").

## Principles

1. Needs you comes first, on every surface, one tap or one key from an answer.
2. One row, one ask card, one status model, five buttons. A new shape needs a design review.
3. One tree, three shapes: pages under 720 px, rail with list and detail above, a side panel from 1400.
4. Quiet chrome, loud content: two fonts, five sizes, two weights, one accent, violet only for attention.
5. The phone is a full client, not a remote.
6. No nagging: Face ID or Touch ID only to pair, release a secret, or send, post, pay or delete
   outside; one proof covers 30 minutes and the screen says so.
7. Smooth is a feature with numbers (below), measured on a real iPhone before we commit.
8. The box serves its own app. No hosted page reaches into your machine.

## Better than Paseo, for Vyre

- One inbox for every kind of waiting, where Paseo only has "needs input" on a session.
- Approvals with keys and swipe, provenance, and the final words before anything leaves.
- Presence that does not nag, where Paseo has none and a cloud relay would need it.
- Offline sends that are never lost (an outbox with replay), where Paseo drops them (#4477).
- Two network paths that fail over silently (Tailscale direct, the relay), a thin reconnect
  pill, and a transcript readable offline.
- Computers, the planner and the vault inside the same rows and the same keys.
- The Capsule and the CLI speak the same words and statuses as the app.
- No loopback prompt, no third-party origin: the phone installs from your box.

## Smooth: the bar

Measured on an iPhone 12 (iOS 18) and a Pixel 6a, installed web app, over the relay and direct
over Tailscale.

| What | Bar |
|---|---|
| Page swipe, list scroll, row swipe | 60 fps; under 1% dropped frames over a 10 s fling |
| Switch between Now, Chats, Agents (mounted) | first content under 100 ms |
| Cold open from the Home Screen, offline | Needs you drawn from cache under 1 s; warm resume under 300 ms |
| Approve swipe | row collapses on the frame the swipe commits (optimistic, outbox, Undo 4 s) |
| Keyboard opens | 0 px jump in the transcript; the composer moves with the keyboard in the same frame |
| Streaming reply | p95 gap between visible updates under 50 ms; no task over 50 ms while streaming |
| Long session | 2,000 turns scroll at 60 fps; 1 h session under 300 MB with no WebKit reload |
| Terminal | key to echo under 50 ms on a direct path |

How the design gets there on the iPhone web app:

- **Gestures on the compositor, not in JavaScript.** Page swipes are a horizontal CSS scroll-snap
  strip; row swipes are a scroll-snap row (the same trick as Mail). Scrolling and snapping run on
  WebKit's scrolling thread, so a busy main thread cannot drop a frame. Native builds use
  Reanimated on the UI thread for the same shapes.
- **One fixed shell, inner scrollers.** The app is `position: fixed; inset: 0` sized to `100dvh`
  (never `100vh`); only inner lists scroll, with `overscroll-behavior: contain`, so there is no
  rubber-band of the whole app and no bounce that drags the header.
- **The keyboard.** iOS shrinks the visual viewport, not the layout. A `visualViewport` listener
  sets one inset variable; the composer moves by `transform` and the transcript's bottom padding
  follows, in one frame. No input under 16 px (no zoom).
- **Safe areas.** `viewport-fit=cover` and `env(safe-area-inset-*)` on the header, the Capsule and
  sheets; the status bar is `black-translucent` in the manifest.
- **No scroll anchoring in Safari.** Safari has no `overflow-anchor`, so the transcript is an
  inverted list (newest at the bottom of a reversed scroller) and history pages load above without
  a jump.
- **Streaming.** The box coalesces deltas to one frame per 60 ms; the app reveals them paced to
  the display, re-parses only the growing block, and uses `content-visibility: auto` on rows off
  screen.
- **Memory.** Lists are virtualized above 100 rows; three pages stay mounted on the phone (one
  when memory is low); the terminal uses the canvas renderer on iOS (WebGL contexts are lost
  under memory pressure); images are sized to the screen.
- **Cold start.** The app shell is precached by the service worker; the last Needs, Chats and
  Agents come from IndexedDB and paint before the network answers.
- **No haptics on the iOS web app.** Every commit has a visible confirmation (the swipe snaps,
  the check morphs, the row collapses); haptics only in native builds and Android.
- **No 300 ms tap delay, no callout.** `touch-action: manipulation` on controls,
  `-webkit-touch-callout: none` on rows, text selection only in messages and code.

**The fallback.** A one-week spike builds Now, a session and the approve swipe as the web app and
measures the bar on a real iPhone. If it misses, the same Expo code ships as a native iOS build:
signed with the user's free Apple ID now (it lasts 7 days and has no push, so the web app stays
installed for notifications), and through the $99 account at launch (TestFlight, APNs push,
system autofill). Android ships the native build from day one.

## Install and onboarding

Decided 27 Sep (tailnet's findings: tailscale#19147, an iOS DNS override, and #18889 and #19504,
the tunnel dropping every few minutes, make the tailnet unreliable as the only phone path):

- **Every phone connects through the relay first** (app.vyre.run, sealed end to end, the relay
  sees only ciphertext) and **switches to Tailscale by itself whenever it answers** (resilience
  R5, silent). Tailscale on the phone is recommended ("faster and private"), never required.
- **iPhone:** the web app, added to the Home Screen from app.vyre.run/pair. No account, no expiry,
  push works; limits as above. The hosted page is pinned to the box's version so no new remote
  code enters the trust path.
- **Android:** the APK installed over adb (full native, exempt from Google's new verification,
  self-updates from the box), or Chrome's Install app. Relay first, Tailscale when reachable.
- **Native iPhone** (free Apple ID, 7 days, no push) stays the advanced path and the smoothness
  fallback.

The flow runs from the laptop ("Add your phone" in Devices, or `vyre phone add`): pick the phone, <!-- terms: ignore -->
scan the single-use relay QR (10 min), install, then live checks the laptop watches turn lime:
reached the box (via relay), HTTPS works, opened as an app, test notification arrived, Face ID key
saved. Then an optional card, "Faster and private: add Tailscale", whose check reads "Switched to
Tailscale · direct 18 ms" once the phone reaches it. Android with a cable: `vyre phone add <!-- terms: ignore -->
--android --usb` installs and opens the app in one step.

## Chat feels like Claude Code

User requirement, 27 Sep: a session in the app behaves like Claude Code in the terminal.

- **Typing while the agent works steers it** (the default): the words join the running turn at
  its next step, and the stream shows "you steered here · after 3 steps" when the agent picks it
  up (thread.steered). ⌥⏎ (a long press on the phone's send)
  queues them for after the turn instead, where they can be edited or taken back.
- **Esc** stops now. **Esc Esc** rewinds this thread to before an earlier message, whose text
  comes back to edit; "also undo file changes" (a hold) needs file checkpoints on.
- **⇧Tab** cycles three modes: Plan first, Asks first, Edits allowed. There is no mode that never
  asks (refused by design); fewer asks come from "Always in <project>" answers. **/** opens commands and skills, **@** files, **!** runs a shell
  line in the session's folder, **#** saves a memory (this project or about you), **⌘V** pastes
  an image, **↑** recalls the last message.
- Thinking collapses to its length and expands; the todo list updates live (side panel on the
  desktop, a pill above the composer on the phone); long commands move to the background (⌃B)
  with Stop and View output.
- On the phone the composer stays usable while the agent streams: Stop and a steer send sit side
  by side.

## Key flows

1. First run: the box's onboarding ends at "Add your phone"; the phone opens on Now with a test
   notification already answered.
2. Glance and answer: a push opens the row; swipe right, done in one gesture.
3. Start a session from the phone: Chats, New, pick the project and the provider, speak or type.
4. Take over a computer: Agents, kit, Take over; hand back with one button.
5. Sign in somewhere: the Capsule or Find, "code northwind", the code copied, one Face ID for 30 min.
6. An alarm: rings on every device, the first answer clears the rest.

## Decisions for the user

1. The direction: A (decided 27 Sep).
2. The install defaults: relay first on every phone, switching to Tailscale when reachable;
   iPhone web app; Android APK over adb. (Decided 27 Sep.)
3. Run the one-week smoothness spike on a real iPhone before committing to the web app on iOS.
4. Violet or teal for attention.
