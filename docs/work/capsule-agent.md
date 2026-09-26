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
- 5 Beacon dot on the menu-bar mark while anything loud waits, "Waiting on you · N" in the menu,
  tooltip; the list is followed from launch (Agent/AgentMenuBar.swift).
- 7 Enter on a sum copies it and closes (Agent/AgentAnswers.swift).
- 8 An offline line when vyred was looked for and is not running.

## Doing
- 6 Wiring the built providers: clipboard, module rows and vault fill with a ⌘K list, one-time
  codes, contacts, Glass (catalog box), watch and drive rows, Watches notifications.

## Next
- 10 Tooling: `vyre up` native-only check, capsule.status and autostart for the native app,
  follow `capsule.requested`, driven mode, open and keystroke timings, perf-check.

## Tests
- CI (capsule-mac on work/capsule-agent): 187 passed, 1 failed; the failure is capsule-pro's known
  contact-photo test. Agent suites: keeper 2, desk 4, route 5, direct 1, small 3.
