---
title: "Windows support: tiers and plan"
summary: The full assessment behind ADR 0037: a file-level inventory of Mac-only versus cross-platform code, four support tiers with sizes and an order, and the open risks.
audience: builders, agents
owner: windows
status: draft
---

# Windows support: tiers and plan

Decision and what shipped from it: [ADR 0037](../adr/0037-windows.md). No Windows hardware was
used for this pass; recommendations that depend on Windows-only behavior are marked unverified.

**Acceptance criteria for Tier A and Tier B, stated now rather than retrofitted later** (cohesion's
interaction pass, `docs/design/interaction.md`, binding for 0.1.1): a Windows device is not "the
Mac app minus native bits." It streams (`memory.ask {stream:true}`, `Render {kind}` once a command's
answer is slow), it updates live off events rather than polling (`sight.stepped`, `context.changed`,
`waiting.changed`), and its motion, card/row states and gestures follow one vocabulary
(`docs/design/one-app/DIRECTION.md`'s smoothness bar and `docs/design/system/components/*`), the
same as every other surface. Tier A ships this for free: the Deck and PWA on Windows are the same
build as everywhere else, so whatever interaction.md specifies there is already there. Tier B ships
it because `vyred` under WSL2 is the same server code as Linux; nothing about the interaction
language is Mac-specific, and none of it is deferred to Tier C.

## 1. Inventory

`vyred` (core/deck/box/CLI) is already cross-platform: `node.yml` runs the full `npm test` suite
on `ubuntu-latest` (Node 22/24), so core, deck, modules, box and most of the CLI pass with no
macOS. Mac-only code is concentrated and gated:

- **Swift native**: `local/capsule/native` (the Capsule app), `local/hands-mac`, `local/screen-mac`,
  `local/sideview`, `local/voice/swift`, `core/vault/mac`, `core/presence/touchid`, `core/link/se`,
  plus the iOS app (`apps/ios`). All `local/*-mac` modules, built via `capsule-mac.yml`.
- **`process.platform === 'darwin'` gates** (~60 files): vault (keychain, Touch ID, login-keychain),
  clipboard (`pbcopy`/`pbpaste`), `local/apps` (installed-app discovery via `osascript`), CLI
  commands (`box`, `capsule`, `up`, `vault`, `doctor`, `connect`, `relay`), `core/system`,
  `core/link/mac.js`, `core/sessions/spawn.js`, `core/daemon/peer.js`, `core/files/index.js`.
  These mostly branch cleanly to a non-mac path today (stub/no-op), which is the pattern to extend.
- **`osascript`**: harness rules/shell, files/drive (Finder), `local/apps` (app launch/discovery),
  keychain test doubles.
- **`security(1)`/keychain**: `core/vault/keys.js`, `core/vault/mac/keychain.swift`,
  `capsule-native.js`, this is the whole native-vault backend on Mac.
- **`launchd`**: `core/daemon/main.js`/`peer.js` (vyred as a LaunchAgent), `local/capsule/native`
  build/install, `local/voice/build.sh`, `local/apps/installed.js`. Linux equivalent today is
  systemd/Docker on the server; nothing here assumes launchd outside these files.
- **Already cross-platform**: the server (Docker on Linux, the recommended home), Deck (web), CLI core,
  Expo phone app + PWA, harness/plugin (`harness/`), relay, Tailscale integration
  (`core/names/tailscale.js` shells out to the `tailscale` binary, not Mac-specific).

Conclusion: the kernel and server were already built to run headless on Linux. The Mac-only surface
is the Capsule (native UI, hotkey, screen context, hands/voice) and the native vault backend, exactly the parts a Windows Capsule would also need to newly build, not retrofit.

## 2. Tiers (cheapest first)

**Tier A, Windows as a device against a Linux server.** Deck in a browser, the PWA, CLI, and Claude
Code + the Vyre plugin (`harness/`) all run on Windows today with near-zero change, since they're
pure Node/web, and inherit the interaction language above for free (same build, same components).
Gaps: `bin/vyre` and `scripts/postinstall.mjs` need testing on Windows paths (no `~`, backslash
paths, no `chmod`); the CLI's `darwin` branches need an explicit "unsupported here, use the Deck"
message instead of failing silently. No native code required. **This is close to done already;
verification is the remaining work.**

**Tier B, `vyred` running on Windows itself**, for someone who wants their own PC as the server
instead of Linux. Recommend **WSL2**, not native Windows Node: the server's Docker Compose
(`box/compose.yml`), systemd-style daemon assumptions, and `tailscale`/`osascript`-shaped shell
patterns all map onto WSL2's Linux userland with no code change, and Docker Desktop already
targets WSL2 as its backend. Native Windows Node would need a second platform branch throughout
`core/daemon`, `core/vault`, `core/files`, `local/apps` for every `darwin` gate, real, ongoing
maintenance. WSL2 costs a heavier install (Docker Desktop or WSL) but reuses the whole Linux
server image unchanged, including every server-side interaction feature above.

**A concrete "Windows already feels alive" milestone, before any Tier C/D native work**: `suggest`
and `sight` are both built, server-side tools with no Mac dependency at all. The moment `vyred`
runs under Tier B (WSL2), `suggest.query` (live command-bar completion) and `sight.now`/
`sight.stepped` (the computer-use status strip, over Glass or the Deck) work unmodified, on Windows,
today's code, no port. Worth stating and testing as its own deliverable, not folded silently into
"Tier B works": it's the first proof that a Windows server isn't a lesser one.

**Tier C, a Windows "Capsule."** Recommend **Tauri** over WinUI 3/.NET or Electron: Tauri gives a
lightweight native shell (Rust core, a web view) matching the design intent behind retiring
Electron on the Mac, with a real global-hotkey API (`tauri-plugin-global-shortcut`) and small
footprint. Build its UI directly on `docs/design/system/components/*`, the same card, row, button
and status vocabulary every other surface uses, not a reimplementation of Vyre's interface in a new
toolkit from scratch: a Windows Capsule that invents its own component language would be exactly
the "flatter, different product" this plan is trying to avoid, just arriving at 0.2 instead of 0.1.
WinUI 3/.NET (C#) is the "most native" option and gets deepest UI Automation access for screen
context, at the cost of a second UI codebase with no code-sharing with the rest of Vyre. Screen
context and computer use are both anchored on Windows UI Automation (UIA), the Windows analogue of
the accessibility tree `local/hands-mac`/`screen-mac` already use, so the module shape carries over
even though the API doesn't. **Tauri is now confirmed (the lead, 2026-09-28), not just
recommended; the full build plan (hotkey, tray, toast, Windows Hello, signing/pinning, CI) is
section 9.** Windows Solo (a Windows PC running everything alone, no Tailscale, per ADR 0039) is
section 8, ahead of Tier C in build order per the lead's current instruction even though it was
originally scoped inside Tier B/C above.

**Tier D, computer use, voice, credentials.** Computer use: UIA for observe, `SendInput` for act,
mirroring `hands-mac`'s observe/find/act/commit/verify loop and its floor (no acting in
password/sign-in surfaces) and stop-key contract. Voice: existing Deepgram/voice module is already
network-based, not Mac-specific, porting is mostly the audio-capture layer. Credentials: Windows
Credential Manager replaces Keychain (`core/vault/keys.js`'s `security(1)` calls), Windows Hello
replaces Touch ID (`core/presence/touchid`), both have first-party Node bindings or a small native
helper, same shape as the current `keychain-helper`/`touchid` split.

## 3. Multiple Windows PCs per person

Same pattern as multiple Macs today: each device pairs into the person's tailnet and gets a device
identity (ADR 0032, person-and-device); "which device is mine" / "answer on this PC" is already a
federation concern (ADR 0021, box-reads-the-mac) generalized to N capsules, not Mac-specific, a
Windows Capsule is just another federated peer. Vyre Drive (Taildrive) is a Tailscale feature, not
ours; Tailscale ships a native Windows client and ADR 0014 (tailnet) already treats the tailscale
binary as a black box via `core/names/tailscale.js`, so this should carry over unchanged.
**Unverified**: Taildrive's Windows-side file-share UX specifically.

## 4. Modularity

Every Windows piece ships as its own `local/*-win` module (`local/hands-win`, `local/screen-win`,
`local/vault-win` or a `vault` backend switch, `local/capsule-win`) behind the same registry/manifest
contract `local/hands-mac` already uses (`module.json` with `does.tools`, `watches.emits`, no cross-
feature imports, enforced by `test/boundaries.test.js`). No fork of `core`; the existing
`darwin`/`else` branches in files like `core/vault/keys.js` become a real platform-backend switch
(`darwin` -> mac module, `win32` -> win module, else -> unsupported) rather than new special-casing
per file.

## 5. Testing without Windows hardware

- `windows-latest` GitHub Actions runners: add a `windows` job to `node.yml` (or a new
  `node-windows.yml`) running the same `npm test`, this alone would catch path/shell assumptions
  today, since nothing currently runs the suite on Windows.
- A dedicated `local/*-win` module's Swift/native-equivalent build (Tauri/Rust or C#) needs its own
  workflow, same shape as `capsule-mac.yml`/`ios.yml`/`android.yml`, a `capsule-win.yml` building
  on `windows-latest`.
- A Windows VM (Parallels/UTM on the Mac, or a cloud Windows PC) is the only way to hand-test UIA,
  Windows Hello and the hotkey, recommend this only once Tier C is actually being built, not for
  the Tier A/B assessment.

## 6. Sizes, order, 0.1.x vs later

| | Size | 0.1.x? |
|---|---|---|
| Tier A verification (Deck/PWA/CLI/plugin on Windows, path fixes, CI job) | S | yes |
| Tier B (WSL2 server path, docs + install script branch) | S-M | yes |
| Tier B's suggest/sight milestone (state + test it, no new code) | S | yes |
| Tier C (Tauri Capsule shell + hotkey, no screen/hands yet) | M | 0.2 |
| Tier D (UIA hands/screen, voice port, Credential Manager/Hello vault backend) | L | 0.2+ |

Recommended order: A -> B -> C -> D. A and B give every current Windows-using client a working
path with days, not weeks, of work and no new native surface. C/D is a real second native client
to build and maintain long-term, worth it once Windows users want Capsule-parity (hotkey, screen
context, computer use), not before.

## 7. Risks and open questions

- **RESOLVED without hardware, per the lead: the local `vyred` socket's Windows ACL is now proven
  in CI, not left to a physical machine.** `config.socketPath()`'s `win32` branch puts the socket
  under a per-user `%LOCALAPPDATA%\Vyre\sockets` folder; `config.ensureWindowsSocketDir` sets an
  explicit `icacls` ACL on it (current user + `SYSTEM` only, inheritance stripped) before
  `ensure()` returns and before `core/daemon/index.js` ever calls `listen()` (`fs.chmodSync` is
  skipped there on `win32`, since it does nothing meaningful). `.github/workflows/node.yml`'s
  `windows-socket-acl` job runs this for real on `windows-latest`: starts `vyred`, checks the
  folder's and the socket file's ACL with `icacls` (parsed by `scripts/win-socket-acl-check.mjs`,
  unit-tested in `test/win-socket-acl-check.test.js`), then proves an actual refusal, a second
  local user's connection attempt fails while the owner's succeeds
  (`scripts/win-connect-probe.mjs`). Not `continue-on-error`: if this job cannot be made to pass,
  Tier A ships in 0.1.1 marked "preview" with the gap written down, per the lead's call, not
  silently green.
- Tier B WSL2 requires Docker Desktop (licensing cost at company scale) or bare WSL2 + Docker
  Engine, which does he want documented/supported?
- Tier C native cost: Tauri vs WinUI 3 is a real fork in long-term maintenance burden (Rust+web vs
  C#), worth prototyping both before committing an ADR.
- UIA parity with the macOS accessibility tree is unverified in depth: some apps (Electron, custom-
  drawn UI) expose weaker UIA trees than AX on Mac, which could make `hands-win` less reliable than
  `hands-mac` for those apps.
- Windows Hello / Credential Manager: unverified whether a Node-native binding exists at the
  quality of the current Swift `keychain.swift`/`touchid` helpers, or whether a small C# helper
  process (mirroring the Mac helper-binary pattern) is needed.
- Taildrive on Windows: unverified UX; needs a hands-on check once a Windows PC exists.
- Claude Code and Tailscale Windows support: both ship official Windows clients (Claude Code via
  npm/native installer, Tailscale via its Windows app) at a level that should cover Tier A/B, but
  neither was hand-verified against this repo's specific assumptions in this pass.

## 8. Windows Solo build plan (the lead's 2026-09-28 "Vyre anywhere" call)

ADR 0039 (owner: anywhere, `docs/design/anywhere.md`) makes "solo / server / device" a
`config.machine` choice with no OS baked into the model: `core/modules/index.js`'s role→bucket
mapping doesn't know or care what OS is running `"solo"` or `"device"`; only the `local/*`
modules do. Windows Solo is that seam, filled in for `win32`, not a new role system:

- **One-command install.** `winget install vyre` (or an `.msi`/`.exe` from the release, if winget
  publishing isn't ready for 0.1.x) runs the same `scripts/postinstall.mjs` path Tier A already
  proved on Windows, then offers "run this PC as Solo" the same way onboarding's "make this the server" path does on the Mac.
  No WSL2, no Docker: Solo is native Windows Node running `vyred` directly (Tier A/B's
  distinction, "native Windows Node vs. WSL2," is about being a **server for other devices**;
  a Solo box with nobody else attaching to it has no need for Docker Compose or the eight
  box-only modules at all, so it skips that cost entirely).
- **anywhere.md's server-setup flow, a Windows twin**, mirroring the Mac section 1:1, same three
  steps, different OS primitive. **Corrected by the lead, 2026-09-28: no Windows Service.** A
  Service runs as SYSTEM or a dedicated service account, not as the signed-in person, which
  breaks both the one-user trust model and `ensureWindowsSocketDir`'s ACL (granted to the
  person's own SID, section 7): a SYSTEM-run vyred would still work for that account, but every
  other assumption in this plan treats `vyred` as running as the person, not as the machine. Use
  a **per-user Task Scheduler logon task** instead, via the built-in `schtasks` (no `node-windows`
  or third-party service-wrapper dependency, no spike needed):
  1. Sets `config.machine` (asks Solo-vs-Server the same way onboarding does).
  2. `schtasks /create /tn "Vyre" /tr "node core/daemon/main.js" /sc onlogon /rl limited` runs
     vyred as the signed-in person the moment they log on, restarting a Solo box's vyred exactly
     the way the Mac's LaunchAgent `RunAtLoad` does, at the person's own privilege level (never
     elevated), which is what the socket ACL already assumes. Logs still go to `core/config`'s
     existing `~/.vyre/logs/` (Windows equivalent of `~`: `%USERPROFILE%`).
  3. **For "this Windows PC is the server" (always-on), the same user-level task set to run
     whether or not the person is logged on** (`schtasks`'s `/rl` and `/it` options, or the
     "Run whether user is logged on or not" flag in the underlying task definition XML), plus a
     power setting: `powercfg /change standby-timeout-ac 0` (or `SetThreadExecutionState
     (ES_SYSTEM_REQUIRED | ES_CONTINUOUS)` held by vyred itself while it's the server) blocking
     idle *system* sleep only, display sleep untouched, same boundary as the Mac's `caffeinate
     -s`. Still a per-user task, still running as the person, just no longer gated on an
     interactive logon.
  4. Task Scheduler's own restart-on-failure action (`schtasks /create ... /ri <minutes> /du
     9999:59` or the task definition's `<RestartOnFailure>`) stands in for `KeepAlive`, restarting
     a crashed vyred, not a clean `vyre down`.
  5. `--undo` runs `schtasks /delete /tn "Vyre" /f`; `config.machine` is the move flow's to
     change, same division as the Mac.
- **Deck in the browser** is Tier A already: `vyre up` opens `http://localhost:<port>` (or the
  paired device flow once a second device exists); Solo needs nothing new here beyond what Tier A
  verification already covers.
- **Owner split, per the lead:** windows builds the schtasks/keep-awake/install-script pieces
  above (this section); anywhere owns ADR 0039 and the role system itself; federation owns the
  move-to-server engine (unchanged by Windows: a Windows Solo box moving to a Linux/Mac server,
  or vice versa, goes through the same copy-then-flip flow, cross-platform by construction since
  it moves files, a re-indexed store and re-encrypted vault entries, not OS-specific state).
- **Open**: none blocking; `schtasks` is a built-in, no spike needed. Still worth a `capsule-
  win.yml`-style CI proof (create the task, log off/on isn't drivable in CI, but the "runs whether
  logged on or not" flag and the restart-on-failure action can both be asserted via
  `schtasks /query` right after creation) before committing to the exact flag set in an ADR
  update, same "prove it in CI, not on hardware we don't have" discipline as the
  socket ACL work in section 7.

## 9. Tier C build plan (the Windows Capsule)

Per the lead's 2026-09-28 instruction: build a thin native shell, not a second UI codebase. The
Mac Capsule's content model (rows, tools, events, tokens) is reused as-is; only the shell differs.
app-design's spec is `docs/design/system/components/capsule-windows.md` (sha `d044f0e1` on
`work/app-design`): Mica on the panel (Acrylic only on the transient tray menu), Segoe UI
Variable/Segoe UI ahead of Helvetica Neue in the font fallback, DWM rounded corners, a tray icon
+ native-feeling context menu, Windows Toast for Needs-you items when the panel is closed,
"Windows Hello" copy (never "fingerprint"/"Touch ID"), high-contrast and transparency-off
fallbacks to solid tokens. That spec is the source of truth for anatomy/states/copy; this section
is only the build plan.

**Shell: Tauri (Rust + WebView2)**, per windows-plan.md section 2's original recommendation,
confirmed by the lead over WinUI 3/C#: it hosts Deck's existing web views (`deck/views/{ask,find,
now,needs}.js` + chat) unmodified inside the panel, so the Capsule's content is the same build as
every other surface, not a reimplementation. Fall back to a small C# + WebView2 app only if a
concrete Tauri gap shows up (a specific WinRT API Tauri's plugin ecosystem doesn't reach), not a
default; switching shells mid-build is expensive, so this is a one-time call to make early, not
revisit per-feature.

**Native bits, each a thin Rust binding, no business logic on the native side** (the pattern is
"native calls a Vyre tool over the socket, same as the Deck's fetch does": the Capsule's brain
stays server-side, in `core/`/`local/capsule-win`, never duplicated into Rust):
- **Global hotkey**: `tauri-plugin-global-shortcut`, default **Alt+Space** (the lead's call,
  2026-09-28: `RegisterHotKey` wins over the system menu when nothing else holds the key, and
  matches PowerToys Run/Raycast-for-Windows convention). While the Capsule panel itself has
  focus, the app's own keydown handler intercepts Alt+Space and closes the panel *before* it can
  reach Windows' system-menu handling, so the system menu never opens on a borderless window that
  has none to show. If `RegisterHotKey` fails (another app already holds Alt+Space),
  Ctrl+Alt+Space is the fallback and the person is told once (a toast, not a silent swap).
  Configurable in Settings either way. **Needs a hands-on check on real Windows** (app-design's
  and the lead's shared flag): windows owns verifying the focused-panel case specifically, most
  reliably via a `capsule-win.yml` CI job that opens the panel and asserts which handler wins,
  falling back to a manual pass on the first Windows VM available if CI can't drive real OS
  keyboard focus.
- **Tray icon + menu**: Tauri's tray API, Acrylic backdrop on the menu only (per app-design's
  Mica/Acrylic split), items exactly as specced (Open Capsule, "Needs you" count, Settings, Quit
  Vyre).
- **Toast notifications**: `tauri-plugin-notification` (wraps Action Center), same words as the
  Needs row, inline actions where the platform allows.
- **Windows Hello for presence**: stands in for Touch ID's role in the confirm-send floor
  (DIRECTION.md principle 6, only sends/posts/payments/deletes ask for it). Candidate API:
  `Windows.Security.Credentials.UI.UserConsentVerifier` via a small WinRT binding (Rust's
  `windows-rs` crate, callable from Tauri), needs a spike to confirm quality/availability parity
  with the Mac's `keychain.swift`/`touchid` helper before committing; this is windows-plan.md
  section 7's existing open question, not new.
- **Screen context via UI Automation**: explicitly *later* per the lead's message (listed for
  sequencing, not this pass): mirrors `local/screen-mac`'s shape once started, Tier D territory.
- **Proof to vyred**: the same model as the Mac's cdhash pin (e2e's `work/e2e-setsid`), an
  Authenticode signature check plus a hash pinned at install time, so vyred only accepts calls
  from the exact signed binary a person installed, not "anything claiming to be the Capsule."
  windows implements the Windows-side pin; the pinning *mechanism* (where the hash is stored, how
  it's verified on each call) should reuse `core/link/se`'s or e2e's existing pin-storage shape
  rather than inventing a second one; needs a short sync with e2e before landing, flagged under
  Needs from others.

**Module shape**: ships as `local/capsule-win`, same manifest contract as `local/hands-mac`
(`module.json`, `does.tools`, `watches.emits`, no cross-feature imports, `test/boundaries.test.js`
enforced), no fork of `core`, per section 4 above.

**CI, no Windows hardware**: a `capsule-win.yml` workflow on `windows-latest`, same shape as
`capsule-mac.yml`: build the Tauri shell (`cargo tauri build` or `build.rs`-driven, TBD once the
project scaffold exists), run its Rust unit tests, and as much of the hotkey/tray/toast surface as
CI can actually drive headlessly (likely: unit-test the hotkey-conflict handler and the
Authenticode-pin check in isolation; a real focused-window Alt+Space race may not be CI-drivable
at all, in which case that specific case is flagged "unverified without hardware" rather than
silently assumed to pass, same discipline as section 7).

**Sequencing**: doc (this section) → agree the look with app-design (done, `d044f0e1`) → agree
the tools/events contract with capsule-pro (below, in progress) → scaffold `local/capsule-win` +
`capsule-win.yml` → wire hotkey/tray/toast → Windows Hello spike → sign/pin. Each milestone
reported to the lead as it lands, per instruction.

**Needs from others**:
- capsule-pro: confirm the Windows Capsule calls the *same* tools/events the Mac Capsule does
  (no new server-side surface for Windows specifically) before windows starts wiring the Rust
  side to them.
- e2e: the pin-storage shape from `work/e2e-setsid`'s cdhash work, to reuse rather than duplicate
  for the Authenticode pin.
- A Windows VM, once CI's headless coverage runs out (the Alt+Space focused-panel case, primarily).
