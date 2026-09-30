# windows

Scope: Windows support for Vyre. "Box" is retired for this work: Windows PCs and Macs are
devices; the server is Linux only (including inside WSL2 on a Windows PC). No Windows hardware
this round; verification leans on windows-latest CI.

## 0.2 status (2026-09-30, current - read this section first)

**User decision 2026-09-30: unsigned for 0.2.** install-windows.ps1 now checks SHA-256 and says
"More info, then Run anyway"; first-run says it too; the app's self-update (`src/update.rs`)
verifies SHA256SUMS.sig with the Vyre release key (release.js scheme), the file hash, and refuses
downgrades; fixture `tests/sums-vector.json` is checked by test/windows-sums-vector.test.js.

**Drive (CI green):** `src/drive.rs` ports core/files/drive-windows.js (UNC, net use args, letter
pick, error text, only 100.100.100.100@8080 shares) with `mount_drive`/`unmount_drive` commands for
bundled pages. OPEN: the remote panel has no IPC, so how the box's files.drive.address reaches the
shell needs a decision with drive/native-core (the shell calling the box itself needs the pairing
session, which is the next step). Unverified on real Windows: WebClient service, 50 MB limit.

**Pairing (CI green):** `src/wink.rs` reads a Wink ticket (locator, MAC, AES-GCM seal, fingerprint)
against a fixture made by core/relay/wire.js; the app registers `vyre://`, honors `pair` only with
the nonce `begin_pair` issued, resolves at relay.vyre.run, shows a confirm window (name + key
fingerprint), then pins https://<handle>.vyre.run. Lead ruled: the shell holds the paired session
and calls the box itself (files.drive.address etc.); the panel stays IPC-free. OPEN: how the Deck
learns the app's nonce; what the shell presents to the box as its session after pairing (needs
tailnet: the shell has no Noise channel yet); own-domain boxes (record has only a handle).

**RESUMED 2026-09-30 (relaunch).** Merged origin/work/stage-0.2 into work/windows (a merge, not a
rebase: 32 old commits, six conflicts, all union-resolved; win32 fresh default is role local,
machine device). Docs and config tests pass locally. Scaffolded the Tauri shell in
`local/capsule/native-win/app/` (steps 2-6): bundled first-run page with the only capability,
main panel with no capability + navigation allowlist + frozen `__VYRE_SHELL__`, tray, global
hotkey via `hotkey.rs`, toast, schtasks autostart. Trust rules are pure and unit-tested in
`src/shell.rs` (pinned origin, `vyre://open` path allowlist, `vyre://pair` nonce). No cargo here:
capsule-win CI (windows-latest, now also `cargo build --release` of the app) is the proof.
Placeholder icon until app-design exports the Lumen icon. Still open: passkey spike 6.1,
pairing through the relay, `net use` Drive mapping, # tag picker, signing key custodian.

Everything below "## Done" through "## Changed contracts" is 0.1.x history (named-pipe device
transport, socket ACL work, the Tier C module-shape draft). **Read it as background, not as the
current design.** The full current plan, with a real architecture pivot mid-session, is
`team/0.2/plans/windows.md` (outside this repo, in the team workspace) - this doc summarizes
where the build itself stands; that file is the source of truth for design and review status.

**The pivot**: Windows 0.2 drops the local `vyred`/named-pipe device entirely (no device-only
tools exist yet to justify it). The app is now a thin Tauri shell (tray, hotkey, toast, autostart,
update) hosting a WebView2 window that loads the real web app at the person's own server address
directly - agreed with cohesion-2/native-core, reviewer-cleared (2 HIGH holds fixed, see the
plan's "Review response, round 2"). The 0.1.2 pipe work below is NOT wasted - it's parked for a
later, separate Windows Solo/Tier B piece (a Windows PC acting as the server), not part of this
app.

**Lead's GO (2026-09-30)**: build, not just plan. In progress this session:
- `scripts/install-windows.ps1` - first draft of the signed-install/update chain (reviewer's
  W-B1, the one BLOCKER on the plan). CLM/AppLocker detection (W-M2) and the SHA-256 check
  against a published SHA256SUMS are real logic; the minisign verification step deliberately
  **throws** (fails closed) because no minisign keypair, SignPath application, or protected
  GitHub environment custodian exists yet (integrator's decision, still open in CHAT.md) - do NOT
  point this at a real release until that's resolved. Autostart uses `schtasks`, matching the
  0.1.2 Windows Solo design already in this doc's "Next" section below. Uninstall is only
  partial (removes the scheduled task and install dir; the box-session-revoke and
  protocol-key/Start-menu cleanup are TODO, flagged in the script itself).
- `local/capsule/native-win/{Cargo.toml,src/lib.rs}` - description/doc comments updated to
  describe the 0.2 shell shape (no local node) instead of the superseded 0.1.2 "Windows Capsule,
  Tier C" framing. `hotkey.rs` itself is unchanged and still directly reusable - its
  conflict-picker logic (Alt+Space default, Ctrl+Alt+Space/Alt+Shift+Space fallback) matches the
  lead's 0.2 ruling exactly.
- **Not yet started**: the actual `src-tauri/` Tauri app skeleton (window, WebView2 navigation
  with the two-context IPC split, tray, capabilities.json), the WebView2 passkey spike with
  native-core (plans/windows.md 6.1 - this is the plan's single biggest open risk, gates
  presence/pairing), the Chrome native-messaging host (new 0.2 scope, section 9 of the plan -
  gated on capsule-sight's runner spike, not started).
- **No `cargo` in this session's sandbox** - nothing Rust has been locally built or tested this
  round either; same "write it, let CI prove it" discipline as the original `hotkey.rs`
  (`capsule-win.yml`, `windows-latest`).

**PAUSED 2026-09-30 02:29 UTC (lead's SAVE AND PAUSE, usage-limit restart).** Exact resume point:

- Last real commit: `aa25d264` on `work/windows`, pushed to `origin/work/windows`. Nothing
  uncommitted of mine in this worktree (the three files `git status` shows modified -
  `docs/design/windows-plan.md`, `docs/index.json`, `docs/reference/index.md` - predate this
  session, are not mine, and were left untouched; do not commit them blind on resume without
  checking their origin first).
- Plan (`team/0.2/plans/windows.md`) is reviewer-CLEARED FOR BUILD as of this session (both HIGH
  holds and all MEDIUM/LOW fixed, "Review response, round 2" section). No open review blockers on
  the design itself.
- **Open questions asked in CHAT.md, no answer yet as of the pause** (check CHAT.md for replies
  before re-asking):
  1. capsule-sight/vault: how the Chrome native-messaging host authenticates its outbound box
     connection with no local vyred (proposed a DPAPI device token) - blocks section 9's design,
     not just its build.
  2. capsule-sight: the extension's ID and the exact native-messaging stdio message shape.
  3. integrator: who custodies the minisign/updater signing key (blocks `install-windows.ps1`'s
     `Verify-Minisign` from ever being implemented for real - it fails closed until this lands).
  4. native-core: pairing on the WebView2 passkey spike (6.1) - not yet scheduled/run.
- **Immediate next steps, in order**: (a) once native-core answers, run the 6.1 WebView2 passkey
  spike together - this gates presence and pairing, the single biggest remaining unknown; (b)
  scaffold the real `src-tauri/` app (window, the two-WebView-context IPC split from plans/
  windows.md section 3, tray, `capabilities.json`) - not started, no files exist yet; (c) once
  integrator names a key custodian, implement `Verify-Minisign` for real in
  `scripts/install-windows.ps1`; (d) once capsule-sight/vault answer question 1 above, start the
  Chrome native-messaging host (section 9 of the plan).

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
- **The socket ACL work (0817eaef, 8cd4722d) was solved for the wrong problem, and is now
  superseded.** windows-socket-acl's first real run failed EACCES with the ACL exactly right
  (confirmed by icacls dumps). Chased retries (723f7b07, wrong: not transient) before a proper
  diagnostic round proved it: a from-scratch folder with zero icacls calls failed identically, a
  plain file created fine in the same folder the socket bind couldn't, and `whoami /priv` showed
  `SeCreateSymbolicLinkPrivilege` Disabled - a bound socket file is an NTFS reparse point, and
  needs that privilege, which most Windows accounts don't hold. **Real fix (b5cfdf5f)**:
  `socketPath`'s `win32` branch is now a literal named pipe (`\\.\pipe\vyre-<hash>`), which needs
  no privilege and no folder. `ensureWindowsSocketDir`/`currentUserPrincipal`/the icacls-checking
  script are all gone. Two CI-only bugs found and fixed along the way: a PowerShell parser error
  in a diagnostic string (b7f37f5c), and windows-latest tearing down a step's background process
  at a step boundary, which had nothing to do with the pipe itself (fd0e4dff: merged start/
  connect/refuse into one step). A third, `net user`'s 14-character legacy-password-length warning
  hanging headlessly (491eb1e2). All fixed and confirmed: the socket binds, the owner connects.
- **The pipe is not ready to ship as-is.** The lead's follow-up (after the ACL fix looked done)
  surfaced three real gaps a filesystem socket never had, reviewer answered all three and the
  rules are now binding (docs/design/windows-plan.md section 7a, 491eb1e2): a hard CI gate on the
  second-user-refused test, a three-part squatting fix (random per-home token, `vyred` must win
  the pipe's first instance and refuse rather than fall back on conflict, a client-side owner-SID
  check), and a standalone helper exe for the peer check (never "unknown peer" -> "allow"). Plus a
  bigger one: process ancestry is spoofable on Windows (`PROC_THREAD_ATTRIBUTE_PARENT_PROCESS`),
  so `PERSON_ONLY` there has to rest on presence, not ancestry - the lead's final call is Windows
  Hello, then the UAC consent prompt (secure desktop, unspoofable by a model), then phone approve,
  no password (phishable/keyloggable). And ADR 0040's same-uid vault problem needs its own Windows
  service-account split, not inherited from the Mac fix. Windows now ships 0.1.2 or later, not
  0.1.1, per the lead.
- **Squatting fix, parts a and b, built and CI-green (1da650d3).** `pipeToken`
  (core/config/index.js) folds a random 16-byte token into the pipe name, persisted at
  `<root>/pipe-token`. Whether libuv sets `FILE_FLAG_FIRST_PIPE_INSTANCE` was left open in 7a
  rather than guessed from source; instead, `windows-socket-acl` now starts a second `vyred`
  against the same home and proves it refuses (exits non-zero, first one still listening
  afterward) - turns out `core/daemon/index.js`'s existing `existsSync`+`ping` pre-check already
  covers this generically, no `win32` code needed, since a crashed `vyred`'s pipe can't linger the
  way a POSIX socket file can. `socketPath` itself has now changed (with 2a+2b together, as
  required).
- **2c built and CI-green (72b595b2, docs 2fa769f4).** `core/daemon/native-win`
  (`vyre-pipe-verify`, Rust + `windows` crate): opens the pipe as a client,
  `GetNamedPipeServerProcessId` for the server's owning pid, `EqualSid` against the caller's own
  token SID. Exit 0 only on a proven match. `lib.rs`'s verdict logic unit-tested cross-platform (3
  tests); `main.rs`'s real Win32 calls only run on `windows-latest`
  (`.github/workflows/windows-pipe-verify.yml`), first fully green run: passes against `vyred`'s
  own pipe, refuses a different local account's (same `net user` trick as `windows-socket-acl`).
  Took 3 CI rounds for the exact API shapes (a missing crate feature, `LocalFree` in a different
  module, `EqualSid` being `Result<()>`-wrapped here rather than raw `BOOL`, `Ok` meaning equal) -
  the security logic itself never changed across those. **Not yet wired into the CLI's real
  connection path** - the tool is built and proven, integration is next.
- Started the `core/presence` conversation directly with reviewer (the lead's call, e2e being
  restarted): proposed `winhello`'s shape (Hello, else UAC consent on the secure desktop, else
  phone) and sharing `core/daemon/native-win` between 2c and point 3's peer-check helper. Not
  agreed yet, no reply.
- Still open from 7a: 1 (worth a deliberate look at the DACL claim specifically, though the gate
  passes), 3 (the peer-check helper exe, likely sharing `native-win` with 2c), 4's `winhello`
  presence method, 6 (Windows `vyre-core` equivalent, waits on ADR 0040).
- Capsule (Tier C) scaffold started, per the lead's instruction to begin before capsule-pro's
  contract reply: `local/capsule/native-win/src/hotkey.rs` (fdd392a6), the Alt+Space-default /
  Ctrl+Alt+Space-fallback decision and the exact focused-panel-vs-system-menu logic app-design
  flagged, host-independent, 9 unit tests, green on `capsule-win.yml`'s first run. Corrected my
  own windows-plan.md module-shape assumption after reading the real Mac Capsule module:
  `local/capsule` is already the one cross-platform module; the shape is a `native-win` sibling to
  `native` (Swift), not a separate `local/capsule-win` that would collide with its tool names.
  capsule-pro confirmed the tools/events contract is the same, no Mac-only server-side surface,
  and flagged two genuinely Mac-specific pieces (`capsule.report`'s hotkey-permission shape,
  Touch ID presence) that need Windows equivalents, not a straight port - tracked in section 7a
  alongside the socket work's own presence gap, one `core/presence` conversation covers both.
- Attribution: per the lead's relayed user rule, no `Co-Authored-By`/`Claude-Session` trailers from
  fd0e4dff onward. Not amending earlier commits on this branch.

## Next
- Reviewer's binding rules (section 7a): build the squatting fix (random token + first-instance +
  refuse-on-conflict) as one piece before touching `socketPath` again, then the standalone helper
  exe for the peer check, then take the `winhello` presence method + ADR 0040's Windows
  service-account split to whoever owns `core/presence` (one conversation, not piecemeal).
- Once the squatting fix lands, re-run the second-user-refused CI check as the hard gate reviewer
  requires, not just "present and green because nothing's tested yet."
- Windows Solo (section 8): `schtasks` needs a CI proof (create the task, assert the "run whether
  logged on or not" flag and the restart-on-failure action via `schtasks /query`) before the ADR
  update commits to the exact flag set.
- Capsule: once capsule-pro's contract reply and the presence conversation both land, wire
  `local/capsule/index.js`'s `native()` to `win32`, scaffold the actual Tauri app (tray, WebView2
  panel), Windows Hello spike, Authenticode sign/pin (reuse e2e's cdhash pin-storage shape, not a
  second one).
- Tier B: a real hands-on WSL2 pass is still owed; docs/using/windows.md says so.
- Tier C/D shell choice (Tauri vs WinUI 3) is now decided (Tauri, confirmed by the lead) - this
  line in an earlier version of this doc is stale.

## Needs from others
- reviewer: sent the named-pipe design (5936e65f); answered, rules are binding (491eb1e2), no
  open question back to them right now.
- core/presence's owner: one conversation covering the `winhello` presence method, the peer-check
  helper exe's trust story, and ADR 0040's Windows service-account split. Not yet sent; next.
- e2e: a read of the role-default change (core/config/index.js, win32 -> local) before it ships;
  and the cdhash pin-storage shape once Capsule sign/pin work starts. Still open.
- integrator: land the windows batch in 0.1.2 (not 0.1.1, per the lead's timeline correction) once
  section 7a's items are actually built, not just designed.

## Changed contracts
- docs/work/README.md: claimed ADR 0037 (windows).
- .github/workflows/node.yml: `test-windows` and `windows-socket-acl` jobs (ci owns this file;
  coordinated by message each time). `windows-socket-acl` no longer sets or checks any ACL; it
  starts a real vyred, connects as the owner, and proves a second local user is refused, all in
  one step.
- .github/workflows/capsule-win.yml: new, builds/tests `local/capsule/native-win` on
  `windows-latest`.
- scripts/lib/docs/check.js: added `windows` to OWNERS.
- core/cli/kit.js: new export `openInBrowser`; core/cli/commands/{up,box,connect,vault}.js now
  call it instead of their own `open`/`xdg-open` spawns. Signature now takes `platform` and
  `spawn` overrides too, for `core/cli/kit.test.js`.
- core/config/index.js: `defaults()` role guess now also treats `win32` as a device (`local`);
  `socketPath`'s `win32` branch returns a named pipe name, not a filesystem path (no `platform`-
  aware ACL helpers left - `ensureWindowsSocketDir`/`currentUserPrincipal` are gone).
- core/daemon/index.js: skips `fs.chmodSync` on `win32` (a named pipe has no file to chmod).
- local/capsule/native-win/: new, `hotkey.rs` + tests, not yet wired into `local/capsule/index.js`.
