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
  after touching core/config and core/cli/kit docstrings.
- Tests: targeted runs all green, no regressions from the openInBrowser/role changes: core/cli/
  commands/{box,connect,up}.test.js, core/config/*.test.js, test/vault-cli*.test.js (91+28+12+21
  tests), test/docs-*.test.js, test/boundaries.test.js (66 tests).

## Doing
- Watching for the windows-latest job's first real run once this lands on main, to see what it
  actually finds (untested locally, no Windows/Windows-VM here).

## Next
- Fix whatever the windows-latest job surfaces (expect path/shell assumptions in scripts, not in
  the four files touched here).
- Once test-windows is reliably green, drop `continue-on-error` and consider folding node/os into
  one matrix if the two jobs' step lists converge.
- Tier B: a real hands-on WSL2 pass is still owed; docs/using/windows.md says so.
- Tier C/D (0.2): prototype Tauri vs WinUI 3 for the Capsule shell before committing further.

## Needs from others
- None blocking right now.

## Changed contracts
- docs/work/README.md: claimed ADR 0037 (windows).
- .github/workflows/node.yml: added `test-windows` job (ci owns this file; coordinated by
  message, landed since ci had not responded and the change is additive/non-blocking).
- scripts/lib/docs/check.js: added `windows` to OWNERS.
- core/cli/kit.js: new export `openInBrowser`; core/cli/commands/{up,box,connect,vault}.js now
  call it instead of their own `open`/`xdg-open` spawns.
- core/config/index.js: `defaults()` role guess now also treats `win32` as a device (`local`).
