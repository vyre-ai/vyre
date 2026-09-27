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
- Terminal tabs on chat's recall.watch (work/chat 10604b9 shapes): history from recall.thread,
  then recall.watch from the last turn id, rows deduped on id (text and "tool:<id>"), tool turns
  as tool lines settled by the next turn or busy false, session.state drives the dot, renew every
  60 s while shown (restart from the last id on not_found), recall.unwatch on tab switch or close.
  Reply labels by chat's labelFor rule (ReplyLabel.of; system.info read once per show). Combined
  tree = work/capsule-pro 834b28e + this branch: 242 pass / 0 fail. Also fixed an ordering flake
  in the screen attach collapse test (async let has no start order).
  Perf: not measured on a live Capsule (no app launch without the lead); cost is one
  recall.watch call a minute while a terminal tab is shown, nothing when hidden.
- 9033c47 sight extension in Sources/Extensions/sight: side view commands, Ask about my screen,
  Option-Return push-to-talk. 12/12 sight tests in a combined scratch copy of capsule-pro's tree
  (174 pass, 1 fail: capsule-pro's own contact-photo icon test).

- Real-vyred perf check on the Mac (2026-09-27, main ef51363 merged as 1449b5d; capsule-pro
  b76552d + this branch's sight, stale askItem line dropped in the scratch copy only). A temp
  home under the test SCRATCH (HOME and VYRE_HOME both), VYRE_NO_DIALOGS=1, fake Tailscale, the
  Mac modules capsule/hands/screen/sideview/voice disabled, recall vectors off; 41 sessions,
  8,300 turns. The real SessionPanelModel + SessionPanelView in one offscreen, unfocused
  "vyre-test" window, following a terminal session through recall.watch. Run through buildlock.
  | Phase | vyred CPU avg / p95 | vyred RSS | panel CPU avg / p95 | panel RSS |
  |---|---|---|---|---|
  | A vyred alone, 60 s | 0.017% / 0% | 110 MB | | |
  | B tab shown, idle, 90 s | 0.022% / 0% | 110 -> 93 MB | 0.066% / 0.66% | 68 MB |
  | C a turn pair every 2 s, 60 s | 0.099% / 0.67% | 93 -> 89 MB | 0.63% / 1.33% | 67 -> 68 MB |
  | D tab closed, 30 s | 0% / 0% | 90 MB | | |
  First show (history + watch) 304 ms. 29 of 29 appended turns drawn, append-to-row p50 27 ms,
  max 28 ms. After close: recall.status watches 0 (the unwatch landed), panel exit 0, home removed.
  p95 figures sit at ps's 10 ms tick (0.67% of a 1.5 s sample). The window was offscreen, so
  compositing is not in the panel number; the SwiftUI updates are. The panel RSS is a harness
  carrying the whole Capsule codebase, not the Capsule's own footprint.

## Doing
- Nothing in flight (2026-09-27). Last: the real-vyred perf check (see Done).

## Next
1. Vyre-owned sessions (ADR 0030): the panel's assistant and thread tabs already follow `thread.*`
   through threads.get + VyState.applyDm, so they pick up SDK sessions with no new call. When
   sessions lands `thread.turn`, `thread.state` and `thread.tool` {call, status}, check that
   capsule-pro's reducer folds them (tool rows by call id, the working dot from thread.state) and
   add panel tests. Terminal tabs stay on recall.watch (the user's own `claude` sessions).
2. capsule-apps slice 4 (WhatsApp over hands): answer any further hands asks.

## Try it (the user, own terminal, a vyred from this worktree in a separate home)
    cd <vyre-dir>/vyre-capsule-sight
    <team-dir>/buildlock.sh capsule-sight sh local/sideview/build.sh
    export VYRE_HOME=/tmp/vyre-sight VYRE_ALLOW_DIALOGS=1
    ./bin/vyre sideview            # --url U, --ratio 0.33, --glass <agent>; ./bin/vyre sideview close
    set -a; source <vault>/.env.vyre; set +a
    printf %s "$DEEPGRAM_API_KEY" | ./bin/vyre voice key
    ./bin/vyre voice               # Enter to talk, Enter to stop, Ctrl-C to quit

## Needs from others
- sessions (ADR 0030), agreed shapes, not landed yet (after the SDK default flip; sessions sends
  the commit): thread.tool {id (= call), call, name, status running|completed|failed|canceled,
  summary, turn}, running once then one final status; thread.state {state starting|idle|running|
  waiting|stopped|failed, turn}; thread.turn {turn "<thread>:<n>", uuid, text}. Live in 33ae9e7:
  thread.started carries provider, model, auth, purpose; thread.stopped reason "idle" means
  resumable, not ended (the panel must not mark the tab closed), or "restart". threads.get keeps
  today's shape for Claude sessions (history stays in the transcripts); later fields are additions.
- LANDED: chat's recall.watch on work/chat 10604b9. Final shapes: recall.watch {session, from?, watch?}
  -> {watch:"w_<hex>", session, from|null, busy}; renew by passing watch (renewed:true); expires 3 min
  unrenewed, 30 min idle; not_found. recall.unwatch {watch} -> {watch, ended:true}. session.turn
  (thread = session id) {session, id, seq (transcript LINE), turn?, role, text, tool?, at, replay?}:
  dedupe on id (text turn id = recall seq as string, tool turn "tool:<id>"; recall.thread items now
  carry id and at). session.state {session, busy} only on change. Callers include capsule.
- chat: `recall.watch {session, from?, watch?}` (renew by id; expires 3 min after last renew,
  30 min idle, recall.unwatch), `session.turn` {session, id, seq, role, text, tool?, at},
  `session.state` {session, busy}; system.info.assistant.name (work/chat 45557bf). Being built.
- capsule-pro: 911c270 merged (834b28e). Their tip does not compile alone:
  Sources/Agent/AgentDestinations.swift:47 calls askItem(q), gone since 013e4e6 (b491743 brought
  the call back). I dropped the line in my scratch copy only.

## Standing rule (user, 2026-09-27)
- Vyre must not nag: the user runs on bypass permissions. No prompt or Touch ID for the person's
  own actions. Touch ID only for pairing a new device, vault secrets, and sending, posting or
  paying outside; one Touch ID lasts about 30 minutes per device.

## Changed contracts
- hands: new tool hands.find; hands.observe takes match; hands.act/commit can fail needs_front.
- New CLI files only: core/cli/commands/sideview.js, core/cli/commands/voice.js (auto-discovered).

## Test windows
- Tiny, offscreen or occluded, unfocused, short-lived, titled "vyre-test" only (never sample data).
