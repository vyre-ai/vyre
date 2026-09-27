# capsule-agent

Branch: work/capsule-agent (off work/capsule-pro) · Worktree: ../vyre-capsule-agent · Owner: capsule-now

The native Capsule's agent half: the 10 retire blockers in docs/work/capsule-parity.md (on
work/capsule-now). capsule-pro merges this branch into work/capsule-pro. Built and tested on
GitHub: `gh workflow run capsule-mac.yml --ref work/capsule-agent` (a push runs it too).

## Files
Mine: `Sources/Agent/*`, `Sources/UI/Agent*.swift`, `Tests/Agent*Tests.swift`. Hooks of a few
lines each in capsule-pro's `Host/CapsuleModel.swift`, `Host/App.swift`, `Host/Panel.swift`,
`UI/CapsuleView.swift`, `Vyred/Catalog.swift` (project people) and `Vyred/State.swift` (DM notice).

## Done
- 9 Stop really stops: `threads.stop {thread}` (was `{id}`); hiding releases the lease and stops
  quick threads, a busy one after its turn (Agent/AgentKeeper.swift).
- 1 Waiting list and cards: gate.held, threads.asks, learn.lessons read on open and at launch,
  kept true by the stream; ↑ from an empty box, ↑↓, ⏎ review, A allow; mail card edited in place,
  ⌘⏎ sends every field (gate.approve edited); asks (threads.answer), lessons (learn.accept /
  retire) with the presence refusal in words; pinned while a card is open (Agent/AgentDesk.swift,
  UI/AgentDeskView.swift, Agent/AgentPanelKeys.swift).
- 2 Destinations: Route.destinations as the rows, first is Enter, ↓ the others, the bar says where;
  the assistant first for the user's own work (with why); an unreachable destination says why on
  its row; @agent picks its matching thread (agents.threads); rows lead the list for a question
  nothing local answers; Tab sends to the first (Agent/AgentDestinations.swift). The catalog now reads
  each project's people, which "own things" needs.
- 3 Follow up in the same thread (first row under an answer), Deeper · sonnet, Copy (button and ⌘C
  in an empty box) (UI/AgentReplyView.swift).
- 4 @agent as a conversation: history (threads.get), asks, pending words reconciled, the reply
  streaming, notices as status (Agent/AgentDirect.swift, UI/AgentDirectView.swift).
- 5 Attention (violet) dot on the menu-bar mark while anything loud waits (capsule-pro's corner dot stays the
  health dot), "Waiting on you · N" in the right-click menu, the tooltip; the list is followed from
  launch and read again when vyred comes back (Agent/AgentMenuBar.swift).
- 6 In the running Capsule: clipboard history (store and watcher), contacts (asked once, from its
  row, only when dialogs are allowed), module rows and vault fill (ModuleProviders), one-time
  codes, Glass (the catalog now reads the box from link.status), watch and drive rows, and
  watched-thread reports as notifications (hidden) or a line (shown); ⌘K lists a row's verbs
  (Agent/AgentWiring.swift).
- 7 Enter on a sum copies it: capsule-pro built it in the same hour; theirs is kept.
- 8 An offline line when vyred was looked for and is not running (Agent/AgentAnswers.swift).
- 10 Tooling: `vyre up` counts the native Capsule as installed (capsule.js nativeAvailable);
  capsule.status reports native and native_built; autostart starts the native app
  (`vyre capsule --hidden`); the app follows capsule.requested (show, hide, toggle); a driven mode
  (VYRE_CAPSULE_DRIVE=1, Agent/AgentDrive.swift) with open and keystroke timings; and
  scripts/capsule-native-check.mjs builds, drives and measures the app on CI.
- capsule.report from the native app: Hotkeys reports once after start() and then only when
  Control twice turns on or off (requestDoubleControl, startDoubleControl, or a tap macOS turned
  off that would not come back on). The message says why in plain words and names the chord that
  still works ("Input Monitoring is off, so Control twice is off. ⌥Space still opens the
  Capsule."). A send that fails because vyred is not up goes again when the follower reconnects.
  The change detection is Host/HotkeyReport.swift (pure); App.swift wires Hotkeys.onChange to
  the call. Headless mode starts no taps and sends nothing.
- The waiting-on-you colour is the violet attention token (Theme.attention, #B8A4FF), matching the
  Deck and the phone: the "WAITING ON YOU" label, the row dot, the selected-row bar, the source
  label, the WaitingHint dot, and the menu-bar mark's dot. The Electron Capsule's waiting label,
  row dot, "HELD FOR YOU" badge, header dot and tray dot are violet too (--attention).
- Fixed a stale line from the capsule-pro merge in Agent/AgentDestinations.swift (a second @app
  branch calling the removed `askItem`), which stopped the native tree compiling.

## Measured (CI, macos-latest, headless driven run, vyred absent)
- open 3.3 to 4.3 ms, keystroke to rows 78 to 86 ms.
- hidden: about 93 MB resident (target 60), 0.015 to 0.2% CPU over 20 s (target 0.1). Reported as
  OVER, not failed: the targets are capsule-pro's. The Electron Capsule was 212 to 238 MB.

## Doing
- Nothing. All 10 retire blockers are in. Waiting for capsule-pro to merge work/capsule-agent.

## Next
- A pop-over row for "Waiting on you · N" in capsule-pro's MenuBarPopover (theirs to place).
- Reports of watched threads on the empty Capsule (Electron listed up to 4); today they are a
  notification or a line.
- threads.unqueue and streaming a queued session's reply (from capsule-now).

## Changed contracts
- The native Capsule now calls capsule.report on hotkey state change (once at startup, then only
  on a change; caller capsule). `vyre doctor` reads it as before.
- Theme.attention (#B8A4FF) is the "needs you" colour in the native Capsule; the Electron Capsule
  has `--attention`. Beacon stays for errors and confirm lines (see Needs from others).

## Needs from others
- Lead / deck-design: Beacon (#FF7A59) is still used for things that are not the waiting list:
  native CapsuleView error line (Stopped.) and an action's confirm line, AgentDirectView and the
  sight SessionPanel failed-turn label and error line, SightPanel and SessionPanel status lines,
  Kit's `Tint.beacon` (IconCache); Electron `.ic.vy.hot` (held glyph wash), the held glyph and
  TONE.held in capsule.js. Keep, or move to attention?

## Tests
- Local, through the build lock: `<team-dir>/buildlock.sh capsule-now local/capsule/native/build.sh test "hotkey report"`,
  then the built binary with the filters "hotkey report" 5, "agent small" 2, "agent desk" 4,
  "snapshot" 3: all passed.
- CI (capsule-mac on work/capsule-agent): native 218 passed, 0 failed. Agent suites: keeper 2,
  desk 4, route 5, direct 1, small 2, wiring 3. Node (on the test box): capsule 15, up 24.
- Known flake, capsule-pro's: frecency debounce under a loaded runner (FrecencyTests.swift:68).
