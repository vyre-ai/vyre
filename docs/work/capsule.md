# capsule

Branch: work/capsule · Worktree: ../vyre-capsule · Milestone: M7 · Wave 1

## Scope

Owns `local/capsule/`, `local/hands-mac/`.

The Capsule is the biggest surface: press Control twice on the Mac and a command bar appears
over whatever you are doing. `@` any agent, project, thread or file; ask; send work to the box;
see held approvals; watch a thread stream; all without leaving the current app. It works offline
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
