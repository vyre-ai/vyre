# capsule-sight

Branch: work/capsule-sight · Worktree: ../vyre-capsule-sight · ADR 0015 (claimed in README.md; capsule-pro moved to 0017, so the numbers no longer clash)

## Scope

1. Screen context from AX (`local/screen-mac`, tool `screen.context`, `screen.shot`).
2. Mac computer use with presence on Send/Post/Pay (`local/hands-mac`, `hands.act`, `hands.commit`).
3. Side view: any session in a panel on the left (about 29% of the display) and Chrome (local,
   or Glass for the box) filling the rest, tiled natively in one gesture
   (brief: team/briefs/sideview-layout.md).
4. Voice: push-to-talk with the Deepgram key from the vault through vyred (`local/voice`).
5. The Capsule half of all four, built into capsule-pro's extension seam
   (`local/capsule/native/Sources/Extensions/sight/`, protocol in capsule-pro's
   `Sources/Kit/Extension.swift`).

## Done
- (claim ADR) ADR 0015 claimed, the floor list (places Vyre never reads or touches), test-owned window.
- (hands) hands: the whole Mac inside the floor, overlay indicator, stop key, commit needs presence.
- (screen) screen: screen.context from AX notifications with a long-lived sight helper, screen.shot.
- (voice snapshot) voice module (lead snapshot): status, settings, speak, the listen stream, mic helper.
- (test(screen) fake-helper) screen tests run on the test box (fake helper, platform darwin). screen 20/20, hands 42/42.
- 201c417 sideview: `local/sideview` + `vyre-tile` + `vyre sideview`. the test box 21 pass, 1 skip (real Mac).
- 9245826 voice: `vyre voice`, `vyre voice key`, `vyre voice status`. the test box 20 pass, 1 skip.
- ADR 0015 written (docs/adr/0015-capsule-sight.md).
- 9033c47 sight extension in Sources/Extensions/sight: side view commands, Ask about my screen,
  Option-Return push-to-talk. 12/12 sight tests in a combined scratch copy of capsule-pro's tree
  (174 pass, 1 fail: capsule-pro's own contact-photo icon test).

## Doing
- Paused (session end 2026-09-27). Nothing in flight. Everything pushed.
- Done since last update: 911c270 SightExtension conforms to capsule-pro's SendAttaching (c61e3af):
  screen chip in the Capsule's main box, 150 ms debounce, 218 pass / 0 fail on c61e3af.
  hands: ec72d08 hands.find + observe match, settleMs cap 5000, key to a background app = needs_front.

## Next
1. When chat lands recall.watch on work/chat: wire the session panel's terminal tabs to it
   (recall.thread history, then recall.watch from the last id, renew every 60 s only while shown,
   unwatch on close/hide, dedupe by seq, session.state drives the working dot) and label replies
   with system.info.assistant.name (null means "Vyre"), read once per show.
2. Check capsule-pro merged 911c270 (they merged up to 45be614 at fcfcef0); remind if not.
3. capsule-apps slice 4 (WhatsApp over hands): answer any further hands asks.

## Try it (the user, own terminal, a vyred from this worktree in a separate home)
    cd <vyre-dir>/vyre-capsule-sight
    <team-dir>/buildlock.sh capsule-sight sh local/sideview/build.sh
    export VYRE_HOME=/tmp/vyre-sight VYRE_ALLOW_DIALOGS=1
    ./bin/vyre sideview            # --url U, --ratio 0.33, --glass <agent>; ./bin/vyre sideview close
    set -a; source <vault>/.env.vyre; set +a
    printf %s "$DEEPGRAM_API_KEY" | ./bin/vyre voice key
    ./bin/vyre voice               # Enter to talk, Enter to stop, Ctrl-C to quit

## Needs from others
- chat: `recall.watch {session, from?, watch?}` (renew by id; expires 3 min after last renew,
  30 min idle, recall.unwatch), `session.turn` {session, id, seq, role, text, tool?, at},
  `session.state` {session, busy}; system.info.assistant.name (work/chat 45557bf). Being built.
- capsule-pro: merge 911c270 (SendAttaching adoption) into work/capsule-pro.

## Standing rule (user, 2026-09-27)
- Vyre must not nag: the user runs on bypass permissions. No prompt or Touch ID for the person's
  own actions. Touch ID only for pairing a new device, vault secrets, and sending, posting or
  paying outside; one Touch ID lasts about 30 minutes per device.

## Changed contracts
- hands: new tool hands.find; hands.observe takes match; hands.act/commit can fail needs_front.
- New CLI files only: core/cli/commands/sideview.js, core/cli/commands/voice.js (auto-discovered).

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
