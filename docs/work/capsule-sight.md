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

## Doing
- Session resumed 2026-09-27 after a restart. Merged main (bfbfd69).

## Next
1. Run screen, hands, voice tests on the test box; fix what fails.
2. Side view: tiling helper + `sideview.*` tools.
3. Capsule extension (sight): "Side view", "Ask about my screen", push-to-talk.
4. ADR 0015 file, CHANGELOG, perf numbers.

## Needs from others
- capsule-pro: the native Capsule host (Sources/Host, UI) so the extension can run in the app.
  Until then the extension compiles against Kit only.

## Changed contracts
- (none yet)

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
