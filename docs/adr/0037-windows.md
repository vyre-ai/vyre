---
title: "ADR 0037: Windows support: tiers and the 0.1.x cut"
summary: Windows PCs are devices, never the server. 0.1.x ships Windows as a client of a Linux server (Deck, PWA, CLI, Claude Code plugin) and a documented WSL2 path to run the server itself; a native Windows Capsule and computer use are 0.2.
audience: builders, agents
owner: windows
status: draft
---

# ADR 0037: Windows support: tiers and the 0.1.x cut

## Context

Some people's main computer is Windows, sometimes more than one. `vyred` (core, deck, box, CLI)
already runs headless on Linux with no macOS in the loop, `node.yml` runs the full suite on
`ubuntu-latest`, and the Mac-only surface is concentrated and already gated behind
`process.platform === "darwin"`: the native Capsule and its modules (`local/capsule`,
`local/hands-mac`, `local/screen-mac`, `local/sideview`, `local/voice/swift`), and the native
vault backend (Keychain, Touch ID, `core/vault/mac`, `core/presence/touchid`). Nothing in the
kernel assumes macOS.

Full assessment, with the file-level inventory: `docs/design/windows-plan.md`.

## Decision

Windows PCs and Macs are **devices**; the **server** is Linux only, a bare Linux machine or a
Linux VM, including one inside WSL2 on a Windows PC (words per ADR 0038, terminology; link added
once it merges). There is no Windows server and no Windows Capsule, and a Windows PC is never
asked to be one.

**`docs/design/interaction.md` (cohesion's interaction pass, binding for 0.1.1) is the acceptance
criteria for Tier A and Tier B, decided by the lead 2026-09-28, not a bar to retrofit once a Windows
device ships**: streaming, live events instead of polling, and the one motion/component vocabulary
in `docs/design/one-app/DIRECTION.md` and `docs/design/system/components/*` apply to a Windows
device exactly as they do to a Mac or the Deck, since Tier A and Tier B run the same client and
server code as everywhere else. Nothing here is deferred to Tier C.

Four tiers, cheapest first:

- **Tier A**, a Windows PC as a device against a Linux server: the Deck in a browser, the PWA,
  the CLI, and Claude Code with the Vyre plugin. Already close to working, since these are pure
  web/Node; ships in 0.1.x.
- **Tier B**, a Linux server on a Windows PC, run inside **WSL2**, not natively on Windows. WSL2
  reuses the existing Docker Compose server image unchanged; a native Windows server would mean
  a second, ongoing platform branch through `core/daemon`, `core/vault`, `core/files`,
  `local/apps` for every `darwin` gate that exists today. Ships in 0.1.x, documented and tested as
  far as `windows-latest` CI allows (no WSL2 there); a hands-on pass on real hardware is still
  needed. Ships with a concrete "Windows already feels alive" milestone for free: `suggest` and
  `sight` are server-side tools with no Mac dependency, so `suggest.query` and `sight.now`/
  `sight.stepped` work on Windows the moment `vyred` runs under WSL2, no port needed; worth stating
  and testing as its own deliverable, not left implicit inside "Tier B works" (cohesion, see below).
- **Tier C**, a native Windows Capsule, most likely Tauri (a Rust shell built on
  `docs/design/system/components/*` directly, the same card/row/button vocabulary every other
  surface uses, not a reimplementation in a new toolkit), a real global-hotkey API, over WinUI
  3/.NET or Electron. 0.2.
- **Tier D**, computer use on Windows (UI Automation + `SendInput`, mirroring `hands-mac`'s
  observe/act/verify/floor/stop-key shape), a voice port, and Windows Credential Manager /
  Windows Hello standing in for Keychain / Touch ID. 0.2.

### Changes landing with this ADR

- `core/config/index.js` `defaults()`: a fresh install's role defaults to `local` (a device) on
  `win32` as well as `darwin`; only a bare non-Mac, non-Windows install still defaults to `box`
  (a server). Existing configs are untouched; role is only ever guessed once, on a fresh install.
- `core/cli/kit.js` gets one shared `openInBrowser(url)`: `open` on darwin, `cmd /c start "" <url>`
  on `win32`, `xdg-open` elsewhere, `VYRE_OPEN_BIN` always wins (tests and overrides). Replaces
  four near-duplicate, Mac-or-Linux-only implementations in `up.js`, `box.js`, `connect.js` and
  `vault.js`, the last of which only opened a browser on darwin at all, so this also fixes it on
  Linux, not just Windows.
- `node.yml` (or an added job in it, see `docs/work/windows.md` for the exact shape once landed):
  a `windows-latest` leg of the same `npm test`, to catch path/shell assumptions with no new
  native code.
- `docs/using/windows.md`: the person-facing how-to for Tier A and Tier B.

## Consequences

- `vyre capsule` already said "not on this device, only macOS" before this ADR, at the CLI level,
  with no vyred needed. `local/sideview` already said the same at the module level (its own
  `SideviewError`, once vyred starts). `local/voice`'s push-to-talk (`vyre voice talk`) did not:
  it printed "vyre-mic is not built. Build it with: sh build.sh" on every non-Mac device, telling
  someone to build a Swift binary that cannot exist on their device. Fixed to say plainly that
  push-to-talk needs the Capsule's mic and is macOS only (`local/voice/talk.js`). `vyre voice
  status` and `vyre voice key` were never Mac-only to begin with and are untouched.
- Tier B is undertested until someone runs it on real Windows hardware; `windows-latest` CI
  proves the Node suite, not WSL2 or Docker Desktop itself.
- Every future Windows-only module (`local/hands-win`, `local/screen-win`, a `vault` backend for
  Credential Manager, a Capsule shell) ships through the existing `local/*` module registry, with
  its own manifest and tests, no fork of `core`, no special-casing per file the way the four
  browser-opening functions had drifted into before this ADR.

## Rejected

- Native Windows Node as the server, instead of WSL2, for Tier B: real, ongoing maintenance (a
  second platform branch everywhere `darwin` is checked today) for no benefit over WSL2, which
  already gets the unchanged Linux image via Docker Desktop's WSL2 backend.
- WinUI 3 / .NET for Tier C over Tauri: deepest native UI Automation access, but a second UI
  codebase with nothing shared with the Deck; left as an open question to prototype against Tauri
  before Tier C actually starts, not decided here.
- Electron for Tier C: already retired on the Mac for the native Capsule; no reason to bring it
  back for Windows.
