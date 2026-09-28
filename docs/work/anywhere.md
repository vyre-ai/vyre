# anywhere

Branch: work/anywhere · Worktree: ../vyre-anywhere · Owner session: anywhere

## Done
- ADR 0039 (docs/adr/0039-vyre-anywhere.md): role as a person's choice (solo/server/device),
  the move-to-server contract, the Mac server service, the loader mapping that keeps the eight
  box-only manifests' `"roles": ["box"]` vocabulary unchanged.
- docs/design/anywhere.md: capability ladder, role-choice copy, move flow (two entry points),
  failure/undo, onboarding + Settings integration, the launchd service shape, the Windows seam.

## Doing
- Sent the design to team-lead for a look before starting item 2 (core role choice in
  core/config).

## Next
1. core/config: three-value role (`solo`/`server`/`device`), migration from `box`/`local` on
   load, tests. Update core/modules/index.js's role→bucket mapping (box↔server+solo,
   local↔device+solo). This is the only kernel change; module.json files for the eight
   box-only modules are NOT touched (ADR 0039 section 1).
2. Audit the eight modules (releases=core/apps, computers, glass, hooks, names, network,
   onboard, relay) for Linux-only assumptions beyond the manifest gate (paths, container
   networking) before claiming they run on macOS.
3. `vyre server here` / `--undo`: launchd plist, keep-awake, login item offer.
4. Coordinate the move engine contract (section 4 of the ADR) with federation; Tailscale/relay
   join wiring with tailnet; onboarding + Settings copy with launch; the Windows seam with
   windows.

## Needs from others
- federation: confirm the move engine can implement ADR 0039 section 4's four-piece contract
  (projects, memory, vault, sessions) and the source-stays-live-until-destination-confirms
  ordering.
- tailnet: does `solo` ever turn on `network.tailscale` (a Solo person's phone reaching the same
  Mac without a full move)? Open question in the ADR.
- launch: onboarding's new "How will Vyre run?" step and the Settings > Server panel, once the
  ADR is agreed.
- windows: Windows Solo needs the seam this ADR names (role mapping is OS-agnostic; `local/*`
  macOS-only modules need Windows equivalents, out of scope here).

## Changed contracts
- `config.role` will change from `"box"|"local"` to `"solo"|"server"|"device"` (not yet built —
  proposed in ADR 0039, not merged). `core/modules/index.js`'s role loader will read the new
  value but manifest `"roles"` fields keep meaning `"box"`/`"local"` as today; no other team's
  module.json needs to change.
