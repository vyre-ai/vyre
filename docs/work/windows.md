# windows

Scope: Windows support for Vyre. "Box" is retired for this work: Windows PCs and Macs are
devices; the server is Linux only (including inside WSL2 on a Windows PC). No Windows hardware
this round; verification leans on windows-latest CI.

## Done
- Assessment: docs/design/windows-plan.md (inventory, tiers, sizes) and ADR 0037
  (docs/adr/0037-windows.md), approved by the lead: Tier A + B for 0.1.x, C + D for 0.2.
- CI: added a `test-windows` job to .github/workflows/node.yml (windows-latest, node 22,
  `npm ci` + `npm test`, `continue-on-error: true` while it's finding path/shell issues, no
  eval:answer/perf-check since those assume a Linux/Mac process model). One job, no new workflow
  file, per the lead's instruction. Messaged ci to coordinate before landing; proceeded once the
  change was self-contained and low-risk (a matrix-free addition, doesn't touch the existing job).
- Tier A code fixes:
  - core/cli/kit.js: new shared `openInBrowser(url)` (darwin `open`, win32 `cmd /c start ""`,
    else `xdg-open`; `VYRE_OPEN_BIN` always wins). Replaced four near-duplicate implementations in
    up.js, box.js, connect.js, vault.js. vault.js's was darwin-only before this, so this also
    fixes it opening a browser at all on Linux, not just Windows.
  - core/config/index.js: a fresh install's role now defaults to `local` (a device) on `win32`
    too, not just `darwin`; only a bare non-Mac non-Windows install still defaults to `box` (a
    server). Existing configs untouched.
  - scripts/lib/docs/check.js: added `windows` to the OWNERS allowlist (was stale, missing several
    live teams already).
- Docs: docs/using/windows.md (Tier A how-to, Tier B WSL2 setup, known gaps), nav.json entries for
  it and the new ADR, docs/adr/0037-windows.md, regenerated docs/reference/* (npm run docs:ref)
  after touching core/config and core/cli/kit docstrings. Pointed both docs at docs' ADR 0038
  (terminology) instead of redefining "server"/"device" myself, per the lead.
- Clearer Mac-only messages (the lead's follow-up ask): checked all three CLI-exposed Mac-only
  surfaces. `vyre capsule` and `local/sideview`'s own SideviewError already said plainly that
  they are macOS only. `local/voice/talk.js`'s push-to-talk did not: on any non-Mac device it told
  the person to build a Swift binary that can't exist there ("vyre-mic is not built. Build it
  with: sh build.sh"). Fixed to say "push-to-talk needs the Capsule's mic, which is macOS only;
  not on this device" off-Mac, kept the build hint on darwin. `vyre voice status`/`key` were never
  Mac-only and are untouched.
- Tests: targeted runs all green, no regressions: core/cli/commands/{box,connect,up,voice}.test.js,
  core/config/*.test.js, test/vault-cli*.test.js (91+28+12+21 tests), local/voice/{talk,voice}.test.js
  (24 tests), test/docs-*.test.js, test/boundaries.test.js (66 tests).
- Cohesion's interaction pass (`docs/design/interaction.md`, sha 5debc1bc, binding for 0.1.1) made
  it explicit that windows-plan.md never mentioned streaming, `Render`, `sight` or DIRECTION.md's
  smoothness bar. Folded in, not stacked on top: docs/design/windows-plan.md and docs/adr/0037
  now state `docs/design/interaction.md` and `docs/design/one-app/DIRECTION.md` +
  `docs/design/system/components/*` as the acceptance criteria for Tier A and Tier B from day one
  (both inherit it for free: same client/server code as every other surface); Tier C's write-up
  now says explicitly to build the Tauri shell on `system/components/*` directly, not reinvent a
  toolkit; and added the "Windows already feels alive" milestone: `suggest`/`sight` are
  server-side and Mac-independent, so they work unmodified the moment `vyred` runs under Tier B
  (WSL2), which is worth stating and testing as its own deliverable. docs/using/windows.md gained
  one line about it too, for the person reading, not just builders. Referenced interaction.md as
  plain text (not a markdown link) since it's only in cohesion's worktree, not merged yet, same
  as ADR 0038.
- Security review (reviewer) on cac517d4 + 63156fe9 found one MEDIUM: `openInBrowser`'s win32
  branch was `cmd /c start "" <url>`, and Node puts an unquoted argument with no spaces straight
  on the command line, so `&`/`|`/`^`/`<`/`>` in it run as `cmd.exe` operators. Every OAuth
  authorize URL has a `&`, so `vyre connect add`'s consent link (or any URL from a paired server)
  would open truncated and run the rest as a command, on Windows only. Fixed: win32 now uses
  `rundll32 url.dll,FileProtocolHandler <url>`, no shell involved, URL as one argv entry; and
  every scheme but `http:`/`https:` is refused, on every platform, `VYRE_OPEN_BIN` included (a
  `file:`/`javascript:` URL was never checked before either). New test: `core/cli/kit.test.js`,
  5 tests covering the injection case, the scheme refusal, and each platform's command. The
  reviewer's LOW (below) is not fixed, it's flagged and open.

## Doing
- Asked e2e for a quick read of the role-default change (win32 now defaults to a device), per the
  lead. Waiting on that before sending cac517d4 onward.
- Sending cac517d4 to the integrator for the first 0.1.1 batch, after rc.2, per the lead.
- Telling the reviewer the MEDIUM is fixed and tested, and flagging the LOW is open, not fixed.

## Next
- Once e2e and the integrator are clear: fix whatever the windows-latest job surfaces once it
  runs on main (untested locally, no Windows/Windows-VM here).
- Once test-windows is reliably green, drop `continue-on-error` and consider folding node/os into
  one matrix if the two jobs' step lists converge.
- Tier B: a real hands-on WSL2 pass is still owed; docs/using/windows.md says so.
- Tier C/D (0.2): prototype Tauri vs WinUI 3 for the Capsule shell before committing further.
- **Blocking, needs the lead's call, not mine to resolve alone:** the reviewer's LOW. The local
  `vyred` socket's Windows security (AF_UNIX vs named pipe, DACL) is unverified; `fs.chmodSync`'s
  0600 has no meaning on `win32`. I can't check this without real Windows hardware, and the
  reviewer's own fallback (disable local `vyred` on win32) would break Tier A's CLI outright, not
  narrow it, since the CLI always talks to a local `vyred`, never the remote server directly. This
  needs either a Windows box to test on, or the lead deciding Tier A ships with this documented as
  a known gap rather than blocked on it. See docs/adr/0037-windows.md's Consequences and
  docs/design/windows-plan.md section 7 for the full writeup.

## Needs from others
- e2e: a read of the role-default change (core/config/index.js, win32 -> local) before it ships.
- integrator: land cac517d4 (and the two follow-up commits) in the first 0.1.1 batch, after rc.2.
- lead: a call on the reviewer's LOW (local vyred socket security on Windows, unverified, no
  hardware here to check it) before Tier A is called fully done.

## Changed contracts
- docs/work/README.md: claimed ADR 0037 (windows).
- .github/workflows/node.yml: added `test-windows` job (ci owns this file; coordinated by
  message, landed since ci had not responded and the change is additive/non-blocking).
- scripts/lib/docs/check.js: added `windows` to OWNERS.
- core/cli/kit.js: new export `openInBrowser`; core/cli/commands/{up,box,connect,vault}.js now
  call it instead of their own `open`/`xdg-open` spawns. Signature now takes `platform` and
  `spawn` overrides too, for `core/cli/kit.test.js`.
- core/config/index.js: `defaults()` role guess now also treats `win32` as a device (`local`).
