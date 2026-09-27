# windows

Scope: assess and plan Windows support for Vyre (no Windows hardware available this round).

## Done
- Inventoried Mac-only surface vs cross-platform (grep for darwin/process.platform/osascript/
  pbcopy/security/launchd/swift across the repo).
- Wrote docs/design/windows-plan.md: four tiers (A: Windows client of a Linux box via Deck/PWA/CLI/
  Claude Code plugin; B: vyred on Windows via WSL2; C: Tauri-based Windows Capsule; D: UIA computer
  use + voice + Credential Manager/Windows Hello), multi-device story, modularity via local/*-win
  modules, CI plan (windows-latest runner), sizes/order, risks.
- Claimed ADR 0037 in docs/work/README.md for windows.

## Doing
- Nothing in flight; this round was assessment only per the lead's instruction.

## Next
- Lead decides which tier(s) to greenlight for 0.1.x (recommend A + B).
- If greenlit: add a windows-latest job to node.yml (or new node-windows.yml) to verify Tier A/B
  today with zero new native code.
- ADR 0037 write-up once a tier is chosen.

## Needs from others
- None blocking. Lead: tier decision, and whether Docker Desktop licensing is acceptable to
  recommend for Tier B.

## Changed contracts
- docs/work/README.md: claimed ADR 0037 (windows).
