# capsule

Branch: work/capsule · Worktree: ../vyre-capsule · Milestone: M7 · Wave 1

## Scope

Owns `local/capsule/`, `local/hands-mac/`.

The Capsule is the biggest surface: press Control twice on the Mac and a command bar appears
over whatever you are doing. `@` any agent, project, thread or file; ask; send work to the box;
see held approvals; watch a thread stream; all without leaving the current app. By default
you talk to the **assistant**, which can drive or monitor any session; `@juno` talks to an agent
directly (`agents.ask`), `@<thread>` types into a session directly (`threads.send`, holding the
lease while you type). It works offline
for the user's own Mac (floor rule 9).

Build from `docs/design/boards/Capsule.dc.html`, `LandingCapsuleDemo.dc.html`, `Cli.dc.html`,
the Glass boards, and `docs/design/TOKENS.md`.

- **Port** the working prototype: the Electron app at `the prototype's bin/electron/` (main.js, app.js,
  index.html, preload), the HUD at `the prototype's bin/hud.html`, and the Swift helpers in
  `the prototype's bin/` (hotkey.swift for the double-Control hotkey, panel.swift, ax.swift,
  axwatch.swift, cursor.swift). It is full of personal names and the old prototype brand: rebrand to
  Vyre and strip everything personal.
- **Onto vyred's API only.** Tools over the local socket (or the box over the tailnet), events via
  `/v1/events/stream`. No private paths, no direct database reads.
- **A module.** `local/capsule/module.json` with role `local`, so `vyred` on the Mac starts it;
  `vyre capsule` opens it. Electron as a devDependency of `local/capsule/` only, never of the
  root package.
- **hands-mac.** Computer use on the Mac through the accessibility tree (`ax.swift`), exposed as
  module tools (`hands.observe`, `hands.act`), every act checked by observing again after
  (see `the prototype's bin/verify.cjs` and `act.cjs` for why a success report is not proof).
- Lessons from memory: the packaged app runs `app.asar`, so editing sources changes nothing until
  it is repackaged. Make `vyre capsule --dev` run from source.

## Done when

Double-Control opens the Capsule on a real Mac; `@` completes projects and threads from a
running vyred; a question to a thread streams back; a held approval shows in Beacon and can be
answered. Screen-recorded or screenshotted against the boards.

## Done
- `local/capsule/`: the Capsule, running from source with `vyre capsule --dev`, against a real
  vyred in a temp home. Verified on this Mac and checked against the board by screenshot:
  a real double-Control opens it over another app with the caret in the box, real key events
  land in it, and Escape hands the keyboard back. Also verified: `@` completes projects and
  threads, the "Sends to" row, memory answers with sources, the source turn, the Beacon waiting
  list, a held draft sent through `gate.approve`, an ask allowed through `threads.answer`, a
  reply streaming from `thread.text`, and the offline state with recovery.
- The switchboard and Gate paths were exercised against stand-in modules in the temp home,
  which register the spec's tool names and emit its events. They were not tested against the
  real switchboard, which has not merged.
- `vyre capsule build --app` packages Vyre.app, and `vyre capsule` runs it only while its source
  stamp matches.
- `local/hands-mac/` (module `hands`): `hands.observe`, `hands.act`, each act verified by
  observing again; real runs on TextEdit and Calculator.
- Swift: `hotkey.swift` (double-Control, `--check`, `--simulate`) and `launcher.swift` (one
  identity for vyred), built by `local/capsule/build.sh`. Not ported, and why: `panel.swift` (the
  Electron panel replaces it; the prototype's own note says XProtect quarantined the unsigned
  Swift panel), `cursor.swift` and `axwatch.swift` (see Next).

- Held drafts are edited inline (no Edit button): To, Subject and body read as text and show one
  underline when focused. Send and Discard are the only actions; ⌘⏎ sends, Esc leaves a field.
  Send calls `gate.approve {id, edited}` with every field on screen, so a revision made elsewhere
  since the card opened never goes out unseen. Verified against the real Gate in a temp home with
  a fake gmail: the subject edited in the Capsule is the subject that went.
- Switchboard shapes from its branch doc: `agents.ask {wait:false}` with the thread named by the
  first `thread.sent` if the stream wins, `threads.send` returning `{sent:false, holder}` and the
  user's ⌘⏎ to take the lease, `threads.answer {surface}`, `thread.text {delta}`, `thread.stopped`.
  Tested against fakes only until the switchboard merges.

- Local results (proposal `docs/proposals/capsule-replaces-spotlight.md`, milestones 1 and 2 and
  settings; double-Control stays the only hotkey, no ⌘Space, no first-run handoff, by the user's
  decision). A bare query ranks apps, System Settings panes, the calculator and unit converter,
  contacts, a definition ("define x"), files and folders (`mdfind`), and Vyre's agents, projects
  and threads in one list (`route.rank`), lifted by frecency from picks. Enter opens a strong
  local match unless the words read as a question (`route.intent`); otherwise the ask row, which
  names the assistant, is highlighted. Tab always asks. Works with vyred down. Contacts: typing
  never raises the macOS dialog; a "Show contacts here" row does, only when picked.
- Measured on this Mac (M-series, Darwin 25), from a test run with the window shown inactive:
  double-Control (second release, from `hotkey --simulate`, modifier flags only) to two frames
  after the page hears it, n=10: median 47 ms, 38 to 74 ms. Keystroke to local results painted,
  n=103: median 11 ms, p90 18 ms. Keystroke to file results painted (includes the 90 ms pause
  for typing to stop), n=12: median 273 ms, p90 322 ms. `mdfind -onlyin ~` alone is 155 to
  480 ms, so files are the slow part.

- Spotlight on steroids, as the user put it (all verified in the app against a temp vyred with
  the real switchboard and the fake Claude, window shown without focus): real icons (apps, files,
  panes, contacts) and one glyph set for Vyre kinds; questions answered in place by haiku, the
  assistant or sonnet, as markdown with copy, cost and memory in gold; clipboard history that
  skips secrets; `@agent` DMs with history; "watch <thread>" with a notification and a report;
  "tell <thread> to <words>", sent as the user and watched.
- Not yet: box files (waiting on `link`'s `files.*` shapes); the assistant driving threads for
  the user (needs the assistant to hold threads.* tools, and switchboard's `threads.watch`, both
  asked); a lean quick-answer thread (one haiku answer cost $0.027, all start-up context; asked
  switchboard for a lean start flag); Open Glass on agent rows (waiting on glass for the address
  tool).

## Doing
- Nothing in progress.

## Next
1. Run against the real switchboard once it merges: `agents.ask`, `threads.send` with the lease,
   `threads.answer`, and `thread.text` deltas. Adjust `lib/state.js` if its payloads differ.
2. An open card does not yet repaint on `gate.revised` from another surface (Send still sends what
   the card shows). Fill a login into the front app with `vault.fill`.
3. Files: a long-lived `NSMetadataQuery` in `bin/local` if `mdfind`'s spawn cost stays the
   bottleneck. Recent files (`kMDItemLastUsedDate`). Boards for the local-results list.
4. Contacts from the packaged app: the dialog is credited to the responsible process, so
   Vyre.app's Info.plist needs `NSContactsUsageDescription`; check it in `build --app`.
3. hands-mac: port `cursor.swift`, so each act shows where it landed, and `axwatch.swift`, to
   observe on change rather than on call.
4. `vyre-launcher` as a signed `.app` with a launchd plist, so vyred on the Mac keeps one
   Accessibility grant across restarts.
5. Paper (light) theme for the Capsule, from TOKENS.
6. Voice into the box (the prototype's ctrl-V dictation), which needs the network, so it must
   fail visibly offline.

## Needs from others
- switchboard: `threads.asks` (the open asks, for a surface that reconnects). Without it the
  Capsule rebuilds them from the last 1000 `ask.raised`/`ask.answered` events. It also needs
  these shapes, or word of a change:
  - `agents.ask {agent, text, new?}` → `{thread}`
  - `agents.threads {agent}` → `[{id, label, last, project, projectName}]`
  - `threads.lease {thread, surface}` → `{holder}`, where a holder other than `capsule` means
    read-only
  - `threads.release {thread, surface}`
  - `threads.answer {ask, decision: allow|deny}`
  - `thread.text {message, text, done}`, where `done:false` is a piece to append
  - `ask.raised {ask, agent?, tool, summary, destination, reason}`, and `ask.answered {ask}`
- gate: met by `42e199a` (the `capsule` caller on gate.get/approve/reject).

## Changed contracts
- `GET /v1/health` also returns `last_event` (the newest event id).
- New module `capsule`: tools `capsule.status` and `capsule.show {action: show|hide|toggle}`,
  and event `capsule.requested {action}`.
- New module `hands`: `hands.observe {app?, pid?, window?, limit?}` and `hands.act {selector,
  kind: press|set|focus|type|key, value?, key?, modifiers?, app?, pid?, window?, settleMs?}`,
  and event `hands.acted`.
- Config: `capsule.autostart` (default off).
