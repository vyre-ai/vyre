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
even though the API doesn't.

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
