---
title: "ADR 0054: A server or a device"
summary: A Vyre install is a server or a device. The Solo shape is retired. An old Solo install keeps its data and is asked to add a server or join one.
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
2. **An old Solo install is not wiped.** When the stored machine is `solo`, or the machine is missing and the role is `local`, the load rewrites the in-memory machine to `device`, sets `needsServer`, and reports one sentence: this install was set up to run only on this computer, that way of running has been removed, and the person adds a server or joins a space. The file on disk is not rewritten by the load.
3. **The person chooses the server.** `onboard.machine` refuses `solo` with `solo_retired` and does not save it. Saving `server` or `device` clears `needsServer`. A module may still set `device` (the relay and onboarding already do). A module may not set `server`.
4. **First run is the same everywhere.** The Mac app, the Windows app and the web page offer Join a team or Add a server. There is no home on this computer and no Solo choice.
5. **An agent can drive the move, and the person taps once.** `onboard.machine`, `onboard.windows` and `releases.info` are kernel tools, so they are MCP tools. A call that changes the device waits on a Needs-you card. Nothing on the device changes until the person taps.

## Consequences

- A Solo install keeps working as a device that still needs a server. Local modules still load, because a device loads the same set.
- Windows enrollment (`onboard.windows`) records the label the person asked for and tells them to open Vyre on that PC and approve it there. The call does not change the device.
- `releases.info` reports the app version and whether the Mac and Windows signing secrets are present. It names the missing secrets and never their values.

## Proof

`core/config/config.test.js` covers the Solo rewrite. `test/onboard.test.js` covers the refusal and the held call. `test/mcp-coverage.test.js` fails if a kernel tool the onboarding, device or invite screens use is not offered through MCP.
