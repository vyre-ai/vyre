---
title: Windows
summary: Use a Windows PC as a device on Vyre with the Windows app, the Vyre app in a browser, the CLI and the Claude Code plugin, pointed at your server.
audience: users
owner: windows
status: draft
---

# Windows

A Windows PC is a device, the same as a Mac or a phone. Vyre has a Windows app for it (a tray icon,
a hotkey panel, notifications, start at logon and self-update), and the Vyre app, the web app, the CLI
and the Claude Code plugin all work there too. In 0.2.9 a home runs on a Mac, a Linux machine or a server; a Windows PC
is never the home, and it runs no sessions of its own. A Windows home comes in 0.3.0 (see
[ADR 0037](../adr/0037-windows.md)).

## As a device, against a server

Everything that is plain web or plain Node already works on Windows with no special setup:

- **The Vyre app**, in any browser, at your server's address, the same as on a Mac.
- **The PWA**: open the Vyre app in Edge or Chrome, then "Install this site as an app" (or the
  browser's Add to Home Screen equivalent) for a windowed, app-like Vyre.
- **The CLI**: `npm i -g vyre`, then `vyre up` to find or be told your server, exactly as on a Mac
  or Linux. `vyre` on Windows is a client only, it never sets itself up as a server (`vyre up`
  will not offer to make this PC one).
- **Claude Code with the Vyre plugin** (`harness/`): install Claude Code for Windows and the
  plugin the same way as on a Mac.

What is missing, and how it fails: Lumen, the Mac command bar with screen context, "do ..."
computer use and voice, runs only on a Mac. `vyre capsule` on Windows says so plainly (`Lumen runs
on macOS. On this machine, use vyre or the Vyre app.`) rather than doing nothing silently. A command
that reaches for a Mac-only tool on the server (`vyre sideview` or `vyre voice`) answers with the
tool not being there, since those parts only start on a Mac; treat that as "not built for this
device yet," not a bug to chase.

If the CLI cannot open a browser for you (signing in, a one-time link, a recovery kit), copy the
address it prints instead, which always works.

## Multiple Windows PCs, one person

Same story as multiple Macs: each device pairs with a Wink and gets its own device identity,
so "which device is mine" and pushing an answer to "this PC" work the same way federation between
a Mac and a server already does (see [ADR 0021](../adr/0021-box-reads-the-mac.md) and
[ADR 0032](../adr/0032-person-and-device.md)), the Windows app is one more
federated device, not a special case.

## The Windows app

The app's installer, `VyreSetup.exe`, is on the latest release at
<https://github.com/vyre-ai/vyre/releases>, and `scripts/install-windows.ps1` (the script behind
`$env:VYRE_CODE='...'; irm https://vyre.run/w | iex`) checks it against the release's published
checksums before it runs. The app lives in the system tray. Alt+Space opens a small panel
anywhere in Windows; if another app already holds Alt+Space, Vyre uses Ctrl+Alt+Space and tells
you once. The panel shows the same Vyre app your server
serves, at its address, and the app shows a notification for what needs you. It can start at
logon, and it updates itself. It pairs with your server by a code shown as a QR and 13 words.
There is no Windows version of the Mac's screen context, computer use or voice yet.

The Windows app is not signed with a Windows certificate yet, so Windows may say it does not
recognize the app. Choose More info, then Run anyway.

The first install checks the installer against the release's `SHA256SUMS`, both fetched over
https. Every update after that is checked by the app itself: it installs a newer version only
when the Vyre release key signed the list of hashes, and it refuses anything unsigned, unlisted
or older.

Vyre Drive appears as a network drive. Windows maps it through its WebClient service, which
refuses files over 50 MB by default. Larger files fail to open until you raise the limit: set
`FileSizeLimitInBytes` under `HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters` and
restart the WebClient service (this needs an administrator, so Vyre does not do it for you).

Pairing this PC shows a code as 13 words and a QR. "Copy the words" puts the words on the clipboard for a
Vyre open on the same PC. The words stay on the clipboard (Vyre does not read it back), and clipboard history or cloud
clipboard sync on Windows may keep a copy. The code stops working after 5 minutes or on first use, so a
kept copy is harmless once pairing ends.
