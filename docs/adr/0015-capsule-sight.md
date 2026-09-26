# ADR 0015 · Screen context, Mac computer use, the side view and voice

Status: accepted, 27 Sep 2026 · Workstream: capsule-sight · Brief: team/briefs/sideview-layout.md

## The problem

The user works with a session on the left of the display and Chrome filling the rest. They want
the session to see the screen, drive Chrome and Mac apps with every action visible, take their
voice, and be put into that layout in one gesture. Each of those reads or moves things that belong
to other apps, so each needs a line it never crosses.

## Decision

Four local modules, each with a small Swift helper built on this Mac and ad-hoc signed, so a
macOS grant attaches to one stable binary and does not widen to all of vyred.

- **The floor** (`local/screen-mac/floor.js`). Places Vyre never reads or touches: password
  managers, system sign-in and permission dialogs, security panes of System Settings. Screen
  context goes blind there (app and window title only), hands refuse, the side view never moves
  their windows.
- **Screen context** (`screen.context`, `screen.shot`). A long-lived sight helper that is idle
  between accessibility notifications and answers from a cache. Secure fields are redacted in the
  helper and again in node. Nothing screen-derived is logged or emitted as an event. Local callers
  only: a tailnet peer is refused. Screenshots are files in a 0700 folder deleted after 60 s,
  never base64 in a result.
- **Hands** (`hands.act`, `hands.commit`). Acts go through the floor first, refuse secure fields in
  favour of `vault.fill`, and hold outward acts (Send, Post, Pay) for `hands.commit`, which needs a
  person's proof. A ring shows where each act lands and a pill says "Vyre is controlling" while a
  session is live; Escape or a double Control stops it. With no indicator, real acts are refused.
- **Side view** (`sideview.open`, `sideview.close`, `sideview.status`). `vyre-tile` runs once per
  call (JSON line in, one line out) and exits: nothing is alive between calls. Node does the layout:
  the session window gets `ratio` (default 0.29, 0.2 to 0.5) of the visible frame of its screen,
  set first; Chrome is fitted from where the session window actually ended, so an app that will not
  go narrow pushes Chrome over rather than under it. `close` restores the frames from before the
  first open. `browser: "glass"` opens the box's `/glass/<name>` page. Opening Chrome and activating
  apps go through `dialogsAllowed()`.
- **Voice** (`voice.status`, `voice.settings`, `voice.speak`, stream `listen`). The mic helper
  writes PCM only while its owner holds stdin open, so a caller that dies takes the mic with it.
  The key stays in the Vault (`voice-deepgram-key`) and is fetched per stream, sent only to the
  provider's fixed origin or a loopback test server. Deepgram streams; OpenAI and ElevenLabs are
  transcribed on release.

## Consequences

- AX cannot animate another app's window, so the side view snaps in one step. A 120 Hz tiling
  animation needs the left window to be ours: the Capsule's own session panel, which waits on
  capsule-pro's native host.
- Until that host exists, the terminal is the way to try things (`vyre sideview`, `vyre voice`),
  and the "assistant in the left panel" case is a terminal or any app named by bundle or pid.
- Every grant (Accessibility, Screen Recording, Microphone) is asked for on first use by the thing
  that needs it, never under tests.
