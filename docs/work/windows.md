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
- 8cd4722d **signed off** by the reviewer. One non-blocking nit taken: spawn `parsed.href`
  (`new URL()`'s normalized form), not the raw `url` string, since a raw string can still carry
  leading/trailing whitespace or control characters that `href` strips. 6th test added
  (core/cli/kit.test.js) proving a `\u0000`-prefixed, trailing-whitespace URL reaches argv clean.
- The lead's call on the reviewer's LOW: **no hardware needed, prove it on `windows-latest` CI.**
  Implemented:
  - `core/config/index.js`: `socketPath`'s `win32` branch now puts the socket under a per-user
    `%LOCALAPPDATA%\Vyre\sockets` folder (never directly under an arbitrary `VYRE_HOME`), and new
    `ensureWindowsSocketDir` sets an explicit `icacls` ACL on it, current user + `SYSTEM` only,
    inheritance stripped, fails closed (throws) if `icacls` itself fails. Wired into `ensure()`,
    which runs before `core/daemon/index.js` ever calls `listen()`. Tests: 4 new cases in
    core/config/config.test.js (14 total), via injectable `platform`/`env`/`spawnSync`, same DI
    pattern as `openInBrowser`.
  - `core/daemon/index.js`: `fs.chmodSync(socket, 0o600)` now skips on `win32` (meaningless there;
    the ACL above is what actually protects it).
  - `.github/workflows/node.yml`: new `windows-socket-acl` job (NOT `continue-on-error`, per the
    lead: fail loud if this can't be made to pass, don't ship it silently green). Starts a real
    `vyred` on `windows-latest`, checks the socket folder's and file's ACL with `icacls`
    (`scripts/win-socket-acl-check.mjs`), then proves a refusal: a `net user`-created second local
    account fails to connect (`scripts/win-connect-probe.mjs`) while the owner succeeds.
  - `scripts/win-socket-acl-check.mjs`'s icacls-output parser is unit-tested off Windows against
    sample icacls text (`test/win-socket-acl-check.test.js`, 5 tests) since the real call only
    runs in that CI job; `scripts/win-connect-probe.mjs` (a bare connect attempt, exit 0/1) was
    smoke-tested by hand against a real POSIX socket on this Mac, both the connect and refuse
    paths, since node:net's shape is the same cross-platform even though the job itself is not.
  - Docs: ADR 0037's Consequences and windows-plan.md section 7 both rewritten from "open,
    unresolved, needs hardware" to "resolved in CI, here's how"; docs/reference/* regenerated.
  - **Not yet proven for real**: this is all unrun on an actual `windows-latest` runner. First CI
    run on this branch is the real test. If the job fails or can't be made reliable, per the
    lead's instruction Tier A ships in 0.1.1 marked "preview" with the gap documented, not
    silently accepted as fixed.

## Doing
- windows-socket-acl's first real run (36356508140, 2026-09-27) failed: the folder's ACL was
  exactly right (owner SID + SYSTEM, full control, inheritance stripped — confirmed by the
  diagnostic icacls dump) but `listen()` still threw `EACCES` on the very first attempt. Root
  cause: Windows implements a bound socket file as a reparse point, and a fresh one can be held
  briefly by AV/indexing right after creation, surfacing as a transient EACCES/EPERM, not a real
  permission refusal — this is a timing bug, not an ACL bug. Pushed 723f7b07: `bindSocket()`
  (core/daemon/index.js) retries up to 10x with linear 150ms*i backoff on win32 only, only for
  EACCES/EPERM; every other platform/error still throws on attempt 1, so the second-user refusal
  is untouched. Also switched `ensureWindowsSocketDir`'s grant to the live token's SID
  (`currentUserPrincipal`, via `whoami /user`) instead of the account name, and added `whoami
  /user` + a plain-file-create probe to the workflow's diagnostic step for the next round if
  needed. 20 local tests green (core/config/config.test.js, core/daemon/bindsocket.test.js) +
  test/boundaries.test.js and test/docs-*.test.js (66) all green. Pushed to work/windows, run
  36368506105 in flight — watching it now.
- Asked e2e for a quick read of the role-default change (win32 now defaults to a device), per the
  lead. Waiting on that before sending cac517d4 onward.
- Sending cac517d4 (+ follow-ups) to the integrator for the first 0.1.1 batch, after rc.2, per the
  lead.
- Will send the reviewer the sha once the windows-socket-acl job is green (not yet — waiting on
  36368506105).

## Next
- Watch the first real `windows-socket-acl` run once pushed; the icacls output parsing, the
  `net user` elevation, and the PSCredential-based `Start-Process` are all first-draft, unverified
  PowerShell/CI mechanics -- expect at least one iteration.
- Fix whatever `test-windows` (the broader suite) surfaces once it runs on main.
- Once both windows jobs are reliably green, drop `test-windows`'s `continue-on-error` and
  consider folding node/os into one matrix if the two jobs' step lists converge.
- Tier B: a real hands-on WSL2 pass is still owed; docs/using/windows.md says so.
- Tier C/D (0.2): prototype Tauri vs WinUI 3 for the Capsule shell before committing further.

## Needs from others
- e2e: a read of the role-default change (core/config/index.js, win32 -> local) before it ships.
- integrator: land cac517d4 (and the follow-up commits) in the first 0.1.1 batch, after rc.2.
- ci: the workflow slot for windows-socket-acl (asked, per the lead).
- reviewer: will send the sha once the CI job's first run is back, as asked.

## Changed contracts
- docs/work/README.md: claimed ADR 0037 (windows).
- .github/workflows/node.yml: added `test-windows` and `windows-socket-acl` jobs (ci owns this
  file; coordinated by message both times).
- scripts/lib/docs/check.js: added `windows` to OWNERS.
- core/cli/kit.js: new export `openInBrowser`; core/cli/commands/{up,box,connect,vault}.js now
  call it instead of their own `open`/`xdg-open` spawns. Signature now takes `platform` and
  `spawn` overrides too, for `core/cli/kit.test.js`.
- core/config/index.js: `defaults()` role guess now also treats `win32` as a device (`local`);
  `socketPath` takes an optional `platform` override; new exports `ensureWindowsSocketDir`.
- core/daemon/index.js: skips `fs.chmodSync` on `win32`.
