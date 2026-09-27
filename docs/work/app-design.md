# app-design

Branch: work/app-design · Worktree: ../vyre-app-design · Owner session: app-design

Scope (lead, 2026-09-27): lead product designer. One app (Expo) for web, iOS and Android that
covers all of Vyre, plus the Capsule and the CLI on the same tokens, and device install with no
Apple Developer account. Absorbs deck-design and phone-design.

## Done

- Direction A (inbox first) decided by the user, 27 Sep. Full sheet published: Direction,
  Smooth, Principles, System, Layout; key screens Needs, Session, Plan and modes, Agents, Planner,
  Vault, Devices; places Onboarding, Projects, Memory, Settings; States, Install 1 and 2, Capsule
  and CLI; every key screen in dark and paper, each with a "Smooth:" note. All pass the audit.
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

- Nothing in flight. The full direction A sheet is published (35 boards).

## Next

- Phase 4 of ADR 0033 (platform; rules adopted in ADR 0033 section 2 at work/platform bebccaee):
  add theme-override validation to scripts/gen-tokens (refuse AA or focus-ring failures, attention
  role or status model changes, text under 12, targets under 44; reject module overrides of global
  tokens), waiting on platform's override file shape. Also a board for module UI slots. Rules already sent 27 Sep: Now card =
  the Needs row, tool card = the tool row plus a template, iframes get theme.css + tokens.json and a
  theme message, a "Modules" rail section (3 pinned), one Settings group per module, and tokens a
  theme may never override (attention role, status model, focus ring, 12 px text, 44 targets, AA).

1. Hand tokens.json to mobile (tokens.ts), deck (tokens.css) and capsule-pro (Theme.swift), with
   a generator and a test that fails off-system values.
2. Propose `vyre phone add` (with `--android --usb|--wireless`) to polish-cli and tailnet.
3. Verify the iPhone web app over a `*.ts.net` address on a real device (Tailscale issue 19147).

## Needs from others

- integrator: when merging, take this branch's scripts/gen-tokens over work/mobile 622224a's, drop
  capsule-pro's hand-written Swift add-on, then run `npm run tokens` and commit the three outputs
  (apps/app/src/theme/tokens.ts, the Capsule's Tokens.generated.swift, deck/css/tokens.css).
- capsule-pro: Theme.swift reads Tokens.monoSizes, not TypeScale.mono.
- deck: switch deck.css to import deck/css/tokens.css when ready.

- User (via lead): violet or teal; confirm the install defaults (iPhone: web app over Tailscale;
  Android: APK over adb); Planner in the desktop rail and the phone's Places sheet.
- sessions: Session board aligned with ADR 0030 (work/sessions 3496b48): provider, model and auth
  in the chip, the state word, Stop (Esc) as interrupt, queued words with Edit, Take back and
  Send now, idle close "Resumes on your next message", Mac-owned asks. ExitPlanMode and mode
  switches still need a surface design (ADR 0030 open question).
- relay: the hosted app at app.vyre.run and the relay QR copy follow ADR 0026 as proposed.

## Changed contracts

- New: scripts/gen-tokens and scripts/lib/tokens.js own the token exports (capsule-pro asked,
  27 Sep). The Swift output's default path is local/capsule/native/Sources/UI/Tokens.generated.swift;
  mono sizes are `monoSizes: [12, 13]` (the hand-written file had `mono: (12, 13)` as size and line).

- docs/nav.json (docs team): design/one-app/README.md and DIRECTION.md added under Contributing;
  docs/index.json and docs/reference/index.md regenerated with npm run docs:ref.
- Proposed only: the CLI verbs `vyre phone add` and `vyre allow` / `vyre deny` (lines marked
  terms: ignore until polish-cli builds them).
