# app-design

Branch: work/app-design · Worktree: ../vyre-app-design · Owner session: app-design

Scope (lead, 2026-09-27): lead product designer. One app (Expo) for web, iOS and Android that
covers all of Vyre, plus the Capsule and the CLI on the same tokens, and device install with no
Apple Developer account. Absorbs deck-design and phone-design.

## Done

- Design canvas "Vyre one app" (private, owned by the user):
  https://claude.ai/artifact/Ap7uKGmbiEs4wM44iSyi1X. 23 boards: Main (principles), System,
  Layout, then Needs you, Session, Agents and Glass, Planner, Vault, Devices, States,
  InstallLaptop, InstallPhones, Capsule and CLI, each key screen in dark and paper.
- Source in docs/design/one-app/ (project/ is the canvas, vyre.css the shared parts),
  tokens.json as the one token source, README.md as the written spec. A copy of the canvas
  source is in <team-dir>/design-backup/one-app/.
- Render audit on testbox (docs/design/one-app/render/render.sh, sizes now read from each
  board's $preview): all 23 boards pass, 0 contrast, 0 clipped, 0 off-system, both themes.
  Every dark board and several paper boards were looked at as PNGs.

## Doing

- Direction A approved (27 Sep). Building the full A sheet: new boards Plan and modes, Projects,
  Onboarding and first run, Settings, Memory; a smoothness pass on every key screen; the States
  crop fix. Violet stays.

## Next

1. Fix the States board's offline pill overlap on the "Now reopened offline" phone crop.
2. Hand tokens.json to mobile (tokens.ts), deck (tokens.css) and capsule-pro (Theme.swift), with
   a generator and a test that fails off-system values.
3. Propose `vyre phone add` (with `--android --usb|--wireless`) to polish-cli and tailnet.
4. Verify the iPhone web app over a `*.ts.net` address on a real device (Tailscale issue 19147).

## Needs from others

- User (via lead): violet or teal; confirm the install defaults (iPhone: web app over Tailscale;
  Android: APK over adb); Planner in the desktop rail and the phone's Places sheet.
- sessions: Session board aligned with ADR 0030 (work/sessions 3496b48): provider, model and auth
  in the chip, the state word, Stop (Esc) as interrupt, queued words with Edit, Take back and
  Send now, idle close "Resumes on your next message", Mac-owned asks. ExitPlanMode and mode
  switches still need a surface design (ADR 0030 open question).
- relay: the hosted app at app.vyre.run and the relay QR copy follow ADR 0026 as proposed.

## Changed contracts

- None. Proposed only: the CLI verb `vyre phone add`.
