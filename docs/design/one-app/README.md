---
title: Vyre one app
summary: One Expo app for the web, iOS and Android, with the Capsule and the CLI on the same tokens, and install with no Apple Developer account.
audience: builders
owner: app-design
status: draft
---

# Vyre one app

The design sheet for one Expo app on the web, iOS and Android, with the Mac Capsule (Swift) and
the CLI on the same tokens and words. It absorbs the Deck's second pass (docs/design/deck.md on
work/deck-design) and the phone spec (docs/design/phone.md). Where this file and those disagree,
this file wins for layout and install. The two earlier files still hold the colour and type
values.

- `tokens.json`: the one source. Exports: tokens.ts (Expo), tokens.css (the Deck), Theme.swift
  (the Capsule), style.js (the CLI). Plain values only.
- `project/`: the canvas boards (`.dc.html`), with `vyre.css` holding every shared part.
- `render/render.sh <Board ...>`: renders boards on testbox and fails any text under WCAG AA,
  any text outside its frame, and any size, weight, family or colour outside the system.

## Principles

1. Needs you comes first: every surface opens on what waits, oldest first, one tap or one key
   from an answer. Violet marks it and nothing else.
2. One tree, three shapes. Layout reads the window width, never the platform.
3. Quiet chrome, loud content: two fonts, five sizes, two weights, eight neutrals, one accent.
4. The phone is a full client: sessions, a terminal with a key bar, Glass take-over, vault,
   planner.
5. No nagging: Face ID or Touch ID only to pair, release a vault secret, or send, post, pay or
   delete outside. One proof lasts 30 minutes, and the screen says so.
6. Survive the network: content stays, one "Reconnecting" pill, an outbox that replays once,
   silent failover between Tailscale and the relay.
7. The box serves the app. No hosted page reaches into the user's machine.
8. Written rules, shared parts: one row, one ask card, one status model, five buttons.

## System

- Type: Instrument Sans; JetBrains Mono for commands, code, paths, IDs and codes. Desktop
  12/16, 13/18, 15/22, 20/26, 28/34. Phone 12/16, 13/18, 17/24, 22/28, 28/34. Weights 400, 600.
- Colour: the Deck's eight neutrals per theme, lime for action, focus, running and selection,
  violet for needs you (teal the one alternative). No other hue. Devices and hosts never get a
  colour.
- Status, one model, most urgent first: needs you (violet dot), failed (crossed circle, text
  colour), running (lime ring with elapsed time), unread (text dot), done (hollow dot). It drives
  rows, tabs, the favicon, the app badge, the Capsule's mark and the CLI.
- Buttons: primary (one per surface), secondary (quiet fill), outline, ghost (Cancel, Deny,
  Discard), hold (destructive: label carries the count, 0.6 s hold). Heights 28, 32; 44 and 54 on
  touch.
- Space 4 to 64 on a 4 grid. Radius 4, 8 (10 touch), 12 (10 phone cards), 14 sheets. Motion:
  tap 120, panel 220, sheet 280, text reveal 150, hold 600, undo 4 s.

## Layout

| Width | Shape |
|---|---|
| under 720 | Pages you swipe (Now, Chats, Agents), the floating Capsule for Find, a Places sheet from the avatar (Projects, Planner, Memory, Vault, Devices, Settings), pushed detail screens |
| 720 to 1099 | 72 rail, list, detail beside it from 900 (replaces the list below) |
| 1100 to 1399 | Rail, list 320, detail capped at 820 |
| 1400 and up | Adds a 340 side panel (plan, changed files, the agent's computer) |

Planner joins the desktop rail. On the phone it lives in Today on Now and in the Places sheet.

## Install without an Apple Developer account

| Platform | Default | Fallback | Advanced |
|---|---|---|---|
| iPhone | The installed web app from `https://vyre.<tailnet>.ts.net` over the Tailscale app | The same web app over the relay (app.vyre.run), no Tailscale on the phone | A native build sideloaded from the Mac with a free Apple ID: expires every 7 days, no push |
| Android | The APK installed by `vyre phone add --android --usb` (or `--wireless`), self-updating from the box | Chrome's Install app (the web app) | The APK downloaded from the box (Google's unverified-developer flow applies from 30 Sep 2026 in four countries, worldwide in 2027) |

The laptop runs the flow (Devices, Add your phone, or `vyre phone add`, a proposed CLI verb): pick
the phone, join the network (Tailscale QR, or a single-use relay QR), open Vyre on the phone,
install, then five live checks (reached the box, HTTPS, opened as an app, test notification,
Face ID key). Pairing asks Touch ID once on the laptop.

Honest limits: the iPhone web app has push (iOS 16.4+), badge, offline cache, camera QR and
passkeys, but no haptics, share target, background sync or system password autofill. Push needs
the box to reach Apple's and Google's push services. Service workers need HTTPS, so
`tailscale serve` certificates are required on the tailnet path (plain `http://100.x` does not
work). An open Tailscale issue (19147) reports iPhones failing TLS to `*.ts.net`; test on a real
device before calling the tailnet path the default. System autofill on iOS and the Mac needs the
paid Apple account.
