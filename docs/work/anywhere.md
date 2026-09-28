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

## Done (cont. 2): 28 Sep, team-lead review round
- Design approved with two tweaks, applied to ADR 0039 and docs/design/anywhere.md:
  1. No auto-delete, ever. Section 4's "vyre server forget" / 24-hour guard is gone; replaced
     with "Free up space on this laptop" in Settings, always previewed (counts, by piece), only
     ever run on the person's explicit confirm.
  2. Solo plus a phone is its own case (new ADR section 5): pairing a second device to a Solo
     machine flips that machine's `machine` from `"solo"` to `"server"` in place: no move, no
     federation involvement, Tailscale/relay turn on only then. This is exactly tailnet's
     `onboard.join.verify` trigger.
- Fixed several leftover `config.role` mentions in sections 3/4/6 that should have said
  `config.machine` (missed in the first pass).
- Added a concrete tool contract for launch and tailnet: `onboard.machine` (new tool,
  core/onboard, HUMAN_ONLY): `{action:"set", machine:"solo"|"server"}` -> `{machine, service?}`;
  Solo needs no call; Device is set by `onboard.join`'s verify step calling back into it. Not
  yet implemented: next.
- Answered launch's "one-command Solo install" question: no new script, `npm install -g
  https://vyre.run/box/vyre.tgz` + `vyre up` (docs/get-started/without-docker.md) already does
  it; flagged that bare `vyre up` needs to stop assuming role=local-looking-for-a-box and ask/
  default the same three-way choice (core/cli/commands/up.js, my own follow-up).
- OK'd tailnet's `onboard.join` proposal; confirmed Solo never touches Tailscale/relay until a
  device actually joins.

## Done (cont. 3)
- `onboard.machine` shipped (sha 73d03d39): `{machine:"solo"|"server"|"device"}` -> `{machine,
  service:null}`. Added to `core/onboard/loopback.js`'s TOOLS allowlist (it was returning
  "no such tool here" otherwise: the loopback session only allows a hardcoded list) and to
  `module.json`'s `does.tools`. `onboard.status` now also reports `machine` alongside `role`.
  `service` is a stub for now: the launchd/keep-awake installer (Next item 2) isn't built yet, so
  `machine:"server"` on darwin does NOT yet actually start the service, only records the choice.
  Told launch and tailnet the contract is real; have not yet told them `service` still no-ops on
  darwin: pending item 2 landing, or a correction if they build against it first.
- Migrated the config tests to config.test.js, added roleBuckets test to modules.test.js, added
  onboard.machine integration test to test/onboard.test.js (real daemon, temp home). All green.
- Fixed docs-check failures the ADR/design doc had picked up: no front matter on design/anywhere.md,
  neither page in docs/nav.json, "anywhere" not a registered owner in scripts/lib/docs/check.js,
  ~70 em dashes (RULES: none, anywhere, not just public copy), and three not-yet-real names
  (`vyre server here`, `vyre stop`, `onboard.join`) that were in backtick code spans, which the
  stale-mention checker treats as real command/tool references: moved to italics instead of
  inventing STALE_ALLOWED entries for things not yet built. docs/reference/* regenerated.
  test/docs-*.test.js 61/61 green.

## Next
1. The launchd plist + keep-awake installer (`vyre server here` CLI and `onboard.machine`'s
   darwin+server path both call into it) -- once it lands, tell launch/tailnet `service` is real
   and update `onboard.machine`'s doc comment.
2. Audit the eight modules (releases=core/apps, computers, glass, hooks, names, network,
   onboard, relay) for Linux-only assumptions beyond the manifest gate (paths, container
   networking) before claiming they run on macOS.
3. `core/cli/commands/up.js`: stop assuming role=local means "find a box"; ask/default Solo.
4. Coordinate the move engine contract (section 4) with federation.

## Needs from others
- federation: confirm the move engine can implement ADR 0039 section 4's four-piece contract
  (projects, memory, vault, sessions), the source-stays-live-until-destination-confirms
  ordering, and the no-auto-delete rule (tweak 1 above: "Free up space" is explicit-confirm
  only, federation's engine should not itself schedule any cleanup).
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
  `core/presence/index.js`, `core/presence/module.js`, `core/onboard/index.js`: these three
  gate real server/not-server behavior, not an OS artifact. No other team's file was touched;
  ~15 other `role === "box"/"local"` sites (planner, term, projects, statusline, link, files,
  vault/watch, sessions/config, modules/federate, cli/commands/*) are untouched and still work,
  since `config.role` itself never changed.
- Verified green on testbox (see Done).
