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

## Doing
- Nothing in progress. Waiting for the switchboard to merge, to run against real sessions.

## Next
1. Run against the real switchboard once it merges: `agents.ask`, `threads.send` with the lease,
   `threads.answer`, and `thread.text` deltas. Adjust `lib/state.js` if its payloads differ.
2. Run against the real Gate once it exists; `fromHeld` reads its fields defensively.
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
- gate: `gate.held` → `[{id, agent, to, subject, body, rule, title?, project, projectName?, at}]`,
  `gate.approve {id, text?}` (an edited draft), `gate.reject {id}`, and events `gate.held`,
  `gate.approved` and `gate.rejected` with `{id}`.

## Changed contracts
- `GET /v1/health` also returns `last_event` (the newest event id).
- New module `capsule`: tools `capsule.status` and `capsule.show {action: show|hide|toggle}`,
  and event `capsule.requested {action}`.
- New module `hands`: `hands.observe {app?, pid?, window?, limit?}` and `hands.act {selector,
  kind: press|set|focus|type|key, value?, key?, modifiers?, app?, pid?, window?, settleMs?}`,
  and event `hands.acted`.
- Config: `capsule.autostart` (default off).
