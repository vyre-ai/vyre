# anywhere

Branch: work/anywhere · Worktree: ../vyre-anywhere · Owner session: anywhere

## Done
- ADR 0039 (docs/adr/0039-vyre-anywhere.md): role as a person's choice (solo/server/device),
  the move-to-server contract, the Mac server service, the loader mapping that keeps the eight
  box-only manifests' `"roles": ["box"]` vocabulary unchanged.
- docs/design/anywhere.md: capability ladder, role-choice copy, move flow (two entry points),
  failure/undo, onboarding + Settings integration, the launchd service shape, the Windows seam.

## Done (cont.)
- Item 2, core role choice, landed as `config.machine` ("solo"/"server"/"device"), additive
  next to the existing `config.role` ("box"/"local") rather than replacing it in place --
  ~15 files across other teams (planner, term, projects, statusline, link, files, vault,
  sessions, cli/commands/*) read `ctx.config.role === "box"`/`"local"` directly, and rewriting
  all of them unreviewed was too much blast radius for one pass (see ADR addendum below).
  `machine` defaults the same way `role` always did (darwin -> solo, else -> server) and is
  migrated once from an explicit legacy `role` if a config.json has one but no `machine`.
  core/modules/index.js's `roleBuckets()` maps `machine` onto the manifests' existing
  box/local vocabulary; daemon now starts the registry and builds Presence with `cfg.machine`,
  not `cfg.role`. Fixed the only three direct `role === "box"` box-only checks that needed to
  move to the new field for correctness (core/presence/index.js, core/presence/module.js,
  core/onboard/index.js) via new `config.isServer()`/`isDevice()` helpers, which also alias the
  legacy "box"/"local" strings so every existing test and caller still works unchanged.
  Verified on testbox: core/config, core/modules, core/presence, core/onboard, core/daemon,
  test/boundaries all green (config 21/21, modules 40/40, presence 134/135 (1 skip), onboard+
  daemon 20/20, boundaries 5/5).

## Doing
- Updating ADR 0039 section 1 / docs/design/anywhere.md to describe `machine` as the new,
  additive field (not a replacement of `config.role`) before flagging this to reviewer --
  the committed ADR text currently says "config.role becomes one of three values", which is
  what I originally tried and rolled back after finding the ~15-file blast radius above.

## Next
1. Fix the ADR/design doc wording (see Doing), then send the two commits (docs + config.machine)
   to reviewer per RULES (role/trust change).
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
- New, additive: `config.machine` (`"solo"|"server"|"device"`), alongside the unchanged
  `config.role` (`"box"|"local"`). New kernel helpers `config.isServer(machine)` /
  `config.isDevice(machine)` (alias legacy `"box"`/`"local"` too).
- `core/modules/index.js` `Registry.start()`'s `role` param now receives `config.machine` from
  `core/daemon/index.js`, mapped onto manifest buckets by the new `roleBuckets()` export. A raw
  `"box"`/`"local"` passed directly (existing tests do this) still works unchanged.
- `core/daemon/index.js` builds `Presence` with `cfg.machine` instead of `cfg.role`.
- Moved from `ctx.config.role === "box"` to `isServer(ctx.config.machine)` in
  `core/presence/index.js`, `core/presence/module.js`, `core/onboard/index.js` — these three
  gate real server/not-server behavior, not an OS artifact. No other team's file was touched;
  ~15 other `role === "box"/"local"` sites (planner, term, projects, statusline, link, files,
  vault/watch, sessions/config, modules/federate, cli/commands/*) are untouched and still work,
  since `config.role` itself never changed.
- Verified green on testbox (see Done).
