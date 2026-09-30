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

## Done (cont. 4): reviewer's HOLD on 80fd866e, fixed
- HIGH, fixed: `isServer("solo")` was `true` (a first pass made solo both a server and a device),
  which put the eight box-only modules -- the tailnet listener, public webhooks, the relay, the
  owner-claim flow -- on every existing/fresh Mac by default. Now `isServer` is true only for
  `"server"` and legacy `"box"`; `roleBuckets("solo")` is `["local"]` only, matching today's
  local role exactly, per team-lead's binding semantics (Solo = full local core, zero
  network-exposing parts, until the person chooses). `defaults()`/`load()` take an injectable
  `platform` param (matching `core/names/tailscale.js`'s own pattern) so the darwin branch is
  covered by tests on any CI machine -- reviewer asked for exactly this test.
- Widened `core/onboard/module.json`'s `roles` to `["box","local"]` myself (it's mine, and
  onboard.machine needs to actually load on a Solo Mac to be reachable at all) -- tailnet is
  doing the same for `relay` separately; told them I'd already done onboard's so they don't
  duplicate it.
- Answered e2e/team-lead's "how does the Deck reach a Solo Mac day to day" in
  docs/design/anywhere.md new section: Capsule keeps using the unix socket unchanged; the Deck
  in a browser needs onboarding's loopback listener (core/onboard/loopback.js) generalized from
  onboarding-only into an always-available `127.0.0.1` server on Solo/Server machines with no
  tailnet address yet, with a new `"loopback"` caller label distinct from tailnet devices. Design
  only -- not built, next item 1.
- Fixed one stale `config.role` mention in ADR section 3 (Undo) that should have said
  `config.machine`; rewrote section 1's solo bullet and bucket table to match the fix.
- Verified on testbox (targeted files, respecting the freeze): core/config/config.test.js 19/19,
  core/modules/modules.test.js 33/33, core/presence/presence.test.js 30/30,
  test/onboard.test.js 16/16, test/boundaries.test.js 5/5, all green.
- Sent to reviewer.

## Done (cont. 5): 28 Sep, team-lead's calls + reviewer's onboard-widening condition
- `roleBuckets` and `Registry.start` take an injectable `platform` param; on darwin, `"server"`
  now includes the `"local"` bucket too (Capsule/voice stay on a Mac chosen as the server), on
  Linux it's `"box"` only, as before. Tested both.
- Six-module audit table added to docs/design/anywhere.md: `onboard`/`relay` widen to `"local"`
  (shipped/tailnet-in-progress); `names`, `network`, `hooks`, `releases`, `computers`, `glass`
  stay box-only -- none of their reasons for existing apply without Tailscale or Docker, which
  Solo doesn't turn on by default. Default was NO per team-lead; nothing overrode it.
- Reviewer's condition on the onboard widening, shipped as ONE coordinated change (not split
  with tailnet): the nine box wizard tools get a shared `boxOnly()` guard, refusing on a
  non-server machine; `onboard.machine` is now `callers: [cli, local, deck, capsule, onboard,
  module]` (no `mcp`, so an agent is refused outright) and requires a presence proof to move TO
  server once an owner already exists (exempt during first-time setup -- no passkey exists yet
  either, and the caller's already proven by the one-time link only cli/local/capsule can mint).
  Tested: an agent caller refused, presence required post-owner, exempt pre-owner, all nine
  wizard tools refuse on solo, onboard.machine/status don't.
- Rewrote "How the Deck reaches a Solo Mac" after reviewer caught a real error in the first
  draft (calling loopback HTTP "trusted like local" -- wrong, no ancestry check exists over
  HTTP). New version: loopback session is never person-level; a session cookie alone is not
  presence; every write needs an actual proof verified independent of person-side vyred; a
  Host/Origin allowlist against DNS rebinding; CSRF on writes. Sent to reviewer, not built.
- Told reviewer the confirmed fix sha (041f87f0, then 6300ecaf for this round) directly; team-lead
  had asked about ae8ee38c, which was the docs-check commit before the actual fix.

## Done (cont. 6): 28 Sep, reviewer's HOLD round 2, remaining two items + merge
- The first four items of the reviewer's round-2 HOLD (presence exemption fixed to
  `role === "box"` only, not any Solo Mac; "device" refused from anyone but
  module:onboard/module:relay; the 7300 setup listener gated on `isServer()`; 8 Claude
  attribution trailers stripped) had already landed at c5d7d318.
- The remaining two, at e22752c9: `onboard.status` now reports `platform` (`os.platform()`) and
  `can.relayJoin` (false with a reason on darwin until vyre-core/ADR 0040 exists to hold a
  paired device's keys off the same-uid vyre.db, true elsewhere), so launch's cards read a fact
  instead of guessing from role/machine. Exported the pure `canRelayJoin(platform)` helper
  (same injectable-platform pattern as config.js/modules.js) so the darwin branch has a direct
  unit test. Fixed docs/design/anywhere.md's two remaining `{ action: "set", machine }`
  mentions of onboard.machine to the shipped `{ machine }` shape (docs/reference/tools.md was
  already correct).
- Merged main (187 commits behind) at b2da8bc8: conflicts in core/presence/index.js (kept both
  this branch's PERSON_ONLY addition for onboard.machine and main's new link.pair/OPT_OUT/
  PERSON_SURFACES/personOnly() derivation) and core/modules/modules.test.js (kept both
  `roleBuckets` and main's `firstParty`/`fileURLToPath` imports); regenerated docs/reference/*
  and docs/index.json after resolving code, not before.
- Green on testbox after the merge: onboard.test.js (25, 2 new), config+modules+presence+
  boundaries+person-only-guard+docs-check suites, 177/177.
- Sent b2da8bc8 to the reviewer and the integrator.

## Done (cont. 7): 28 Sep, reviewer's LOW on c5d7d318 (port 7300)
- Reviewer flagged that a Mac chosen as server still resumes/mints the setup loopback on
  onboardPort's default, 7300, the exact port RULES forbid binding on a Mac (its own real
  onboarding tunnel to the box). "Next free port if taken" (ADR 0002) still names 7300 on the
  first listen() call before failing over, so the fix is a different default outright, not a
  better fallback.
- `defaultOnboardPort(platform)`, at 74f8832a: 7301 on darwin, 7300 (ADR 0002, unchanged)
  everywhere else; an explicit `network.onboardPort` still wins on every platform, box included.
  Pure and exported (same pattern as `canRelayJoin`), so the darwin branch has a direct unit
  test rather than mutating `process.platform`. Updated ADR 0002's listener table and the
  generated config.md description (scripts/lib/docs/reference.js's hand-authored copy).
- Green on testbox: onboard.test.js 26/26 (1 new), config+modules+presence+boundaries+
  person-only-guard+docs-check, 178/178.
- Sent 74f8832a to the reviewer.

## Done (cont. 8): 30 Sep, relaunch as the Mac-as-server owner
- Merged stage/0.2 (04d6f6f1). Read RULES, CHARTER, PLAN section for anywhere, launch's work log.
- `scripts/install-mac-server.sh` (test/install-mac-server.test.js, 8/8, temp home, fake launchctl/
  caffeinate/brew/colima): the Mac server install path. Person's own account, never root, no password.
  Checks Node 22.5+, installs the release into ~/.vyre-server/app (SHA256SUMS-checked, or --from DIR),
  Colima via Homebrew with DOCKER_HOST at Colima's own socket (Docker Desktop untouched, unused),
  writes VYRE_SETUP_CODE and VYRE_SETUP_CODE_AT (epoch seconds) into VYRE_HOME/vyre.env at 0600 (never
  an argument, never printed), one LaunchAgent (run.vyre.server) running vyred under `caffeinate -ims`
  (keep-awake with nothing system-wide to restore, so no pmset), a wrapper that reads vyre.env line
  by line, never executes it, and drops a code older than an hour. --dry-run, --uninstall, --purge.
- Honest limits: (1) a LaunchAgent starts at login, not at boot with nobody signed in: that is the
  vyre-core LaunchDaemon (ADR 0040 phase 4), not on stage/0.2 yet. (2) tailnet's beginSetup (work/
  tailnet-02) and every relay pair path still refuse on darwin via macCoreRefusal, so the setup page
  cannot reach a Mac server through the relay until vyre-core lifts it. (3) launch's install-box.sh
  darwin branch still prints the npm line; the one-line dispatch to this script is launch's to make.
  (4) macOS ships LibreSSL, whose `openssl dgst` has no `-mac`, so launch's mailbox progress stream
  in install-box.sh cannot be copied to the Mac unchanged. (5) Colima's pinned-binary fallback (no
  Homebrew) is not built: it needs a hash we pin at release; without Homebrew the script says so and
  agents get no computer.

## Done (cont. 9): 30 Sep, phase 4 (lead's rulings: no setup-only exception, I own work/vyre-core)
- work/vyre-core (../vyre-core) now carries my installer commits (release manifest verify, root installer,
  LaunchDaemons for core, update and vyred and Colima, signed apply step) and has stage/0.2 MERGED in (not
  rebased: 19 commits each conflicting on generated docs). Resolved: presence role is cfg.machine, reach entries
  and the core flag both kept, vault kinds import from lib/vault-kinds, the macOS session test injects its
  Capsule stand-in. vyre-core, boundaries, docs, presence, modules, daemon tests green.
- work/anywhere-server was reset onto work/vyre-core (backup: backup/anywhere-server-0930) with my three script
  commits replayed. scripts/install-mac-server.sh default mode = system service: pinned Node fetched, release
  + manifest + signature checked against SHA256SUMS, ONE sudo runs the root installer, enrolment line read and
  dropped, waits for vyred and core's socket. `--login-only` is the old LaunchAgent mode. Colima pinned-binary
  fallback (no Homebrew) feeds the Colima LaunchDaemon in system mode. test/install-mac-server.test.js 24/24.
- Fixed: `out=$(sudo ...; printf rc)` died under set -e in a substitution; now && / ||.

- Phase 5 built (0ef9f34e): core/vyre-core/keys.js + keys.* tools, lib/vyre-core-keys.js (createCoreKeys, fakeCoreKeys),
  core/vyre-core/keys.test.js. Answer to tailnet: async only, caller = any owner-uid process outside every Claude session.
- Found: the root extract did not strip npm pack's package/ folder (release.js extract, fixed 66f3a020, tested).
- work/vyre-core == work/anywhere-server (ff'd), pushed at 66f3a020. Proof: .github/workflows/mac-server.yml runs
  scripts/mac-proof/run.sh on macos-latest (throwaway release key via scripts/mac-proof/release.mjs, real sudo, PATH
  without brew so the Colima/Lima/docker pins are checked for real). RESULT: pending (run on work/vyre-core).

- 30 Sep, reviewer-2's round fixed (H1 verify before sudo + root copies/hashes, H2 placeholder gate, M1 staging, M2 pax, M3 audited keys + ADR 5a). Real release key pinned (release.js + script). gh in the installer (--gh-bin). scripts/sign-manifest.mjs + release.yml signing on publishing runs on main. First runner proof failed only at my keys check (launchd leader "unknown"), fixed; rerun pending the push (branch CI was still running).

## Next
1. (done, see above) Phase 5 (co-built with tailnet): core keys tools (keys.exists/ensure/box.pub/box.dh/route.pub/route.sign),
   lib/vyre-core-keys.js client + fakeCoreKeys, on work/vyre-core.
2. Ask reviewer-2 for review of work/vyre-core; land.
3. GitHub macOS runner proof: workflow builds a release signed with a throwaway key (key patched into the test
   tarball's release.js), runs the real script + real sudo, checks _vyre, daemons, core socket, vyred, pinned Colima.
4. Then merge work/vyre-core into work/anywhere-server, review, land.

## Needs from others
- federation: answered their vault/sessions atomicity question (no atomic pairing needed; their
  existing final-confirm-gate-before-flip already covers it, as long as nothing on the
  destination acts before the flip). Flagged that ADR 0040 may change WHERE the vault piece
  lands on the destination once it exists, not the four-piece shape.
- windows: Windows Solo needs the seam this ADR names (role mapping is OS-agnostic; `local/*`
  macOS-only modules need Windows equivalents, out of scope here).
- e2e: co-owns ADR 0040 with me; three sections still owed (see Next item 1).

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
