---
title: "ADR 0054: A server or a device"
summary: A Vyre install is a server or a device. Solo is not a mode. There is no move from solo to a server.
audience: builders
owner: anywhere
status: stable
---

# ADR 0054: A server or a device

Status: accepted, 15 Oct 2026. Supersedes the Solo shape in [ADR 0039](0039-vyre-anywhere.md). The rest of that record stands.

## Context

ADR 0039 named three shapes: Solo (one computer, no server), an always-on computer as the server, and a cloud server. Solo was the first-run choice "Use My Home" and the config value `machine: "solo"`.

A person who runs only on one computer cannot be reached by a phone, a second computer, or an agent on another machine. The product is one experience on the web, the Mac app and the Windows app, and that experience always has a server: one you run, or one you join.

## Decision

1. **Two machines.** `config.machine` is `server` or `device`. `isDevice("solo")` is false. A fresh Mac or Windows install defaults to `device`. A fresh Linux install defaults to `server`.
2. **Solo is not a mode.** A stored `machine` of `solo` loads as `device`. There is no notice, no error code, and no tool for a move. The file on disk is not rewritten. A role of `local` with no machine is already a device.
3. **`onboard.machine` accepts server or device.** `solo` is not a value, so the call is `bad_input` and nothing is saved. A module may still set `device` (the relay and onboarding already do). A module may not set `server`.
4. **First run is the same everywhere.** The web page, the Mac app and the Windows app use the same screens: Identity, a space, then Ready. There is no Solo choice. Those screens call `onboard.*`. When the server has them, those tools call `identity.create`, `identity.unlock`, `devices.signin` and `wink.install.issue`, `wink.install.status` and `wink.install.complete`.
5. **A person in the app does not wait.** An assistant's change to people, devices or vault access waits on a Needs-you card. Nothing changes until the person taps. An assistant never receives a vault value, and a tap does not reveal one. `releases.info` is a read of the version and the names of missing signing secrets, and it does not wait.

## Consequences

- A file that still says `solo` loads the local modules, because a device loads that set. Nothing asks the person to move it.
- Windows enrollment (`onboard.windows`) records the label the person asked for and tells them to open Vyre on that PC and approve it there. The call does not change the device.
- `releases.info` reports the app version and whether the Mac and Windows signing secrets are present. It names the missing secrets and never their values.

## Proof

`core/config/config.test.js` covers a stored solo loading as a device with no notice. `test/onboard.test.js` covers `solo` as bad input, the vault refusal, and the held device change. `test/mcp-coverage.test.js` fails if a kernel tool the onboarding, device or invite screens use is not offered through MCP.
