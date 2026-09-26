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
- Adopted capsule-pro 3882f65's seams in the sight extension: the panel slides in ease-out and out
  ease-in (SessionWindowCurve); the "Side view: <name>" rows and the panel's tabs re-read the
  session list on thread.started / thread.stopped and call host.commandsChanged() only when it
  changed (following stops on hide unless the panel is open); live terminal sessions (from
  projects.catalog, active in the last 15 min, not run by the switchboard) get a tab whose
  history is read from recall.thread and marked "History from the index, may be a few seconds
  behind"; words to them go through threads.send, which queues. Combined tree on 3882f65:
  208 pass, 1 fail (capsule-pro's contact-photo icon test).
- Screen context on Ask (ScreenAttach.swift): done in the sight extension and the session panel;
  combined tree 203 pass, 1 fail (capsule-pro's icon test). Waiting on capsule-pro's host hook
  (proposed SendAttaching / SendAttachment in Kit) to show the chip in the Capsule's own box;
  the adapter wraps `SightExtension.screenAttachment(for:) async -> (id, chip, bundle, body)?`.
- hands asks from capsule-apps (WhatsApp ax adapter): hands.find + observe match, settleMs cap
  5000, needs_front for a key to a background app. hands tests on the test box: 53 pass, 6 skip.
- e263e22 + f7830bd: session panel in the sight extension (Capsule-owned window slides in at 29%,
  Chrome fitted by sideview.open `panel`). Combined tree 191 pass, 1 fail (capsule-pro's icon
  test); the test box: sideview 15 pass, 1 skip. Builds only against capsule-pro's UNCOMMITTED host
  (ExtensionHost.swift, Stream.swift, sessionWindow(owner:)): waiting on their commit.
- 35b22ad: Talk uses capsule-pro's public VyredLink.stream; own WebSocket code deleted (-275/+59).
  Combined vs 4b15618: 190 pass, 1 fail (their icon test). Builds against COMMITTED 4b15618 now.
- Real-Mac test skipped per lead: the user tries `vyre sideview` himself.

## Next
1. When capsule-pro commits extension loading: rebuild combined, then push for a capsule-mac.yml build.
   Next after the panel (lead): voice push-to-talk inside the native Capsule, verified in the app.
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
- chat team: `recall.watch {session, from?}` + `session.turn` events (+ optional `session.state`) for
  live terminal tabs in the session panel. Asked 2026-09-27; wire it up when it lands.
- capsule-pro: answer on the SendAttaching Kit hook (screen chip in the main box).
- capsule-pro: the native Capsule host (Sources/Host, UI) so the extension can run in the app.
  Until then the extension compiles and tests but does not run. Also asked of capsule-pro:
  `VyredLink.stream(path:)` for WebSocket streams (sight reuses the internal VySock today),
  confirm Option-Return as the talk chord, and a contract for a Capsule-owned session panel
  window (the side view's left side for the assistant, animated tiling).

## Changed contracts
- hands: new tool hands.find; hands.observe takes match; hands.act/commit can fail needs_front.
- New CLI files only: core/cli/commands/sideview.js, core/cli/commands/voice.js (auto-discovered).

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
