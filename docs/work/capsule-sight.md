# capsule-sight

Branch: work/capsule-sight · Worktree: ../vyre-capsule-sight · ADR 0015 (claimed in README.md)

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
- c7844c9 ADR 0015 claimed, the floor list (places Vyre never reads or touches), test-owned window.
- f5d7a9e hands: the whole Mac inside the floor, overlay indicator, stop key, commit needs presence.
- 73e48e5 screen: screen.context from AX notifications with a long-lived sight helper, screen.shot.
- 788d5fb voice module (lead snapshot): status, settings, speak, the listen stream, mic helper.
- 10ea172 screen tests run on the test box (fake helper, platform darwin). screen 20/20, hands 42/42.
- e1540a6 sideview: `local/sideview` + `vyre-tile` + `vyre sideview`. the test box 21 pass, 1 skip (real Mac).
- 7c7be45 voice: `vyre voice`, `vyre voice key`, `vyre voice status`. the test box 20 pass, 1 skip.
- ADR 0015 written (docs/adr/0015-capsule-sight.md).
- f1dfc57 sight extension in Sources/Extensions/sight: side view commands, Ask about my screen,
  Option-Return push-to-talk. 12/12 sight tests in a combined scratch copy of capsule-pro's tree
  (174 pass, 1 fail: capsule-pro's own contact-photo icon test).

## Doing
- Waiting on the lead (Mac free for the real side view test) and capsule-pro (host).

## Next
1. When capsule-pro's host runs extensions: try the sight extension in the app.
2. Real-Mac side view test when the lead says the Mac is free:
   `VYRE_MAC_REAL=1 nice -n 15 node --test local/sideview/real.test.js` (needs screen-mac testwin built).
3. perf-check numbers for sideview (one-shot) and voice idle.

## Try it (the user, own terminal, a vyred from this worktree in a separate home)
    cd <vyre-dir>/vyre-capsule-sight
    <team-dir>/buildlock.sh capsule-sight sh local/sideview/build.sh
    export VYRE_HOME=/tmp/vyre-sight VYRE_ALLOW_DIALOGS=1
    ./bin/vyre sideview            # --url U, --ratio 0.33, --glass <agent>; ./bin/vyre sideview close
    set -a; source <vault>/.env.vyre; set +a
    printf %s "$DEEPGRAM_API_KEY" | ./bin/vyre voice key
    ./bin/vyre voice               # Enter to talk, Enter to stop, Ctrl-C to quit

## Needs from others
- capsule-pro: the native Capsule host (Sources/Host, UI) so the extension can run in the app.
  Until then the extension compiles and tests but does not run. Also asked of capsule-pro:
  `VyredLink.stream(path:)` for WebSocket streams (sight reuses the internal VySock today),
  confirm Option-Return as the talk chord, and a contract for a Capsule-owned session panel
  window (the side view's left side for the assistant, animated tiling).

## Changed contracts
- New CLI files only: core/cli/commands/sideview.js, core/cli/commands/voice.js (auto-discovered).

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
