---
title: Windows
summary: Use a Windows PC as a device on Vyre, the Deck in a browser, the PWA, the CLI and the Claude Code plugin, pointed at a Linux server, and set up that server itself inside WSL2.
audience: users
owner: windows
status: draft
---

# Windows

"Server" and "device" are defined in ADR 0038 (terminology; link added once it merges); in short,
a Windows PC is a device, same as a Mac or a phone, and the server is Linux only, including one
inside WSL2 on a Windows PC (below). There is no native Windows server and no Windows Capsule
yet; both are 0.2 work (see [ADR 0037](../adr/0037-windows.md)).

## As a device, against a server

Everything that is plain web or plain Node already works on Windows with no special setup:

- **The Deck**, in any browser, at your server's address, the same as on a Mac.
- **The PWA**: open the Deck in Edge or Chrome, then "Install this site as an app" (or the
  browser's Add to Home Screen equivalent) for a windowed, app-like Vyre.
- **The CLI**: `npm i -g vyre`, then `vyre up` to find or be told your server, exactly as on a Mac
  or Linux. `vyre` on Windows is a client only, it never sets itself up as a server (`vyre up`
  will not offer to make this PC one; see [Tier B](#as-a-server-inside-wsl2) if that's what you
  want).
- **Claude Code with the Vyre plugin** (`harness/`): install Claude Code for Windows and the
  plugin the same way as on a Mac.

What is missing, and how it fails: anything that is really the Capsule (the global hotkey,
screen context, "do ..." computer use, voice) is Mac-only today. `vyre capsule` on Windows says
so plainly (`The Capsule runs on macOS. On this machine, use vyre or the Deck.`) rather than doing
nothing silently. A command that reaches for a Capsule-only tool on the server (`vyre sideview`
or `vyre voice`) answers with the tool not being there, since those modules only start on a Mac;
treat that as "not built for this device yet," not a bug to chase.

Two current rough edges, tracked for 0.1.x:
- The CLI opens a browser for you (signing in, a one-time link, a recovery kit) with `cmd /c
  start`. If nothing opens, copy the address it prints instead, that always works.
- A brand-new install defaults its role to a device (`local`), the same as a Mac; `vyre config
  set role local` fixes it by hand on an older install that guessed wrong.

## As a server, inside WSL2

Recommended path for someone who wants their own Windows PC to be the server, not just a device
against one elsewhere: run the Linux server **inside WSL2**, not as native Windows. The server is
a Docker Compose stack (`box/compose.yml`, two containers: `tailscale` and `vyre`); Docker Desktop
targets WSL2 as its backend already, so this is the same server image every Linux install uses,
completely unchanged.

1. Install WSL2 (`wsl --install` in an admin PowerShell) and a Linux distribution (Ubuntu is
   fine).
2. Install Docker Desktop for Windows with the WSL2 backend enabled, or Docker Engine directly
   inside the WSL2 distribution.
3. Inside the WSL2 shell, follow the ordinary Linux server setup: [Box care](box-care.md) and
   [Tailscale](tailscale.md), unchanged.
4. Everything past that point, Tailscale, the Deck, other devices connecting in, behaves like
   any other Linux server; WSL2 is invisible to them.

This is not yet exercised on real Windows hardware; it is tested as far as possible on GitHub's
`windows-latest` CI runners (which do not have WSL2), and needs a hands-on pass on an actual
Windows PC before calling it done.

## Multiple Windows PCs, one person

Same story as multiple Macs: each device pairs into your tailnet and gets its own device identity,
so "which device is mine" and pushing an answer to "this PC" work the same way federation between
a Mac and a server already does (see [ADR 0021](../adr/0021-box-reads-the-mac.md) and
[ADR 0032](../adr/0032-person-and-device.md)), a future Windows Capsule would just be one more
federated device, not a special case.

## What's next (0.2)

A native Windows Capsule (a Tauri shell, most likely, see the plan) with its own hotkey, screen
context through Windows UI Automation, computer use, voice, and Windows Credential
Manager/Windows Hello standing in for the Keychain/Touch ID. None of this exists yet. Track it
under `windows` in `docs/work/`.
