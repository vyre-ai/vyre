# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## Done
- ADR 0033 accepted by the lead (decisions recorded in the ADR). Inventory in its appendix.
- Team asks sent 2026-09-27: native-core (module settings into the registry: they pick "settings reads manifests" or an internal settings.register), sessions (providers shape frozen by the schema; hooks seam in canUseTool, P4), polish-cli (verb shapes, who writes module.js/update.js), app-design (card shapes, iframe tokens, slot placement), pwa (slot registry + sw caching of /m/<module>/), ci (lib/* in boundaries, the release workflow), chat (renderer slot heads-up).
- P0 written: packages/module-sdk (manifest.schema.json, manifest.js checkManifest, index.d.ts, package.json private, README), test/module-sdk.test.js, docs drift fixes in docs/architecture/spec.md and docs/build/module-contract.md.

## Doing
- P0 for batch 4: the integrator takes the newest work/platform tip (passes over work/native-core too).
- settings.write: work/platform-settings-write e4515fb6 (worktree ../vyre-platform-sw), approved by e2e, HELD until e2e signs off native-core.
- Store limits (security, e2e HIGH 2 fix): work/platform-store-limits c9f1d630 (worktree ../vyre-platform-sl), on native-core 390ff807, settings+modules 40/40. Sent to native-core to adopt before they merge. e2e's other items (CALL_AS scoped to setter tools; settings.set/reset PERSON_ONLY) are native-core's.
- ONE HUB (user directive): ADR 0033 section 3 rewritten (9f133f35). No overrides/; theme = hub keys appearance.theme + appearance.tokens (checked by lib/theme before storing); prompt layers listed and toggled in the hub. Asked native-core for: hub file + live hand edits, per-key check hook, choices from a tool, prompt-layer toggle key. P4: a first-party `theme` module (mine) declares appearance.* and serves /theme.css and /v1/theme.

## Next
(Resume after logout 4: all three branches pushed; nothing uncommitted.)
1. native-core: confirm they adopted work/platform-store-limits c9f1d630 before merging; answer their reply on the four hub asks (hub file + live hand edits, per-key check hook, choices from a tool, prompt-layer toggle key).
2. settings.write e4515fb6: hand to the integrator only when e2e signs off native-core.
3. P0: confirm the integrator took the newest work/platform tip into batch 4.
4. P1 once native-core's settings are on main: loader adopts packages/module-sdk/manifest.js (add packages/module-sdk to package.json files); apiVersion; ctx.api, ctx.log levels, ctx.paths.data, ctx.settings (get/on via settings.get + settings.changed, set via settings.write); watches.on and needs.tools for home modules; replaces (name == replaces) and disable; registry.status() rows gain `commands` (polish-cli's dispatcher reads GET /v1/modules); core/cli/commands/module.js (aliases ["modules"], remove modules from daemon.js, GROUPS "Under the hood") per polish-cli kit.js conventions, they review.
5. P2: `vyre update` (Mac: install then vyre up's restart path; box/vyre: refresh box files, vyre:prev + src.prev, backup, APK fetch/check/copy android.json last + android.json.prev, `vyre call releases.sign`). Reads GitHub Releases API (stable = newest non-prerelease, beta = newest). SHA256SUMS over TLS. Rollback restores DB only if health fails in the update window; --restore-data asks a typed confirm. Fixture = ci's dry-run dist/ (release.yml work/ci 4b49ecf5, VYRE_RELEASES gate).
6. P3 to P5 per ADR 0033 (P4 includes the first-party `theme` module for appearance.theme/appearance.tokens using app-design's lib/theme; first lib/ adds "lib" to package files).

## Needs from others
- ci: release.yml on work/ci 4b49ecf5. APK asset is android-<version>-<sha7>.apk and android.json's `file` is rewritten to match. Dry run only until repo variable VYRE_RELEASES=go. Its dist/ artifact is the P2 test fixture shape; waiting on the dry-run result.
- (decided) first tag 0.1.0 after the native-core milestone; Cloudflare token for the mirror asked at 0.1.0. Both recorded as open in ADR 0033.
- mobile (answered, work/mobile cb4e988c): android.json {version, versionCode, sha, sha256 (unsigned), size, minSdk>=24, built, file}; tool `releases.sign {}` (callers cli/local/module, idempotent, errors no_release/release_mismatch); folder config releases.android default <home>/releases/android/, APK first then android.json atomically last; signed copies never deleted. P2 wrapper: host fetch+check, compose cp in, keep android.json.prev, `vyre call releases.sign` in the container.
- polish-cli: reviews core/cli/commands/module.js and update.js (module.js gets aliases ["modules"], remove `modules` from daemon.js, add both to GROUPS). They write the P4 does.commands dispatcher; wants the shape { verb, tool, summary, args? }.
- integrator: "open" for testbox, then P0 into batch 4.
- native-core: a way for modules' manifest `settings` to join the registry (registry reads `modules.list` manifests, or a `settings.register` internal tool), and `ctx.settings` scoped to the module's own keys.
- sessions: `does.providers` shape stays as on work/sessions; `does.hooks` (brief/enrich/pretool/stop) placement vs the SDK driver's canUseTool.
- polish-cli: `vyre module ...` and `vyre update` verbs next to `vyre config`.
- app-design, pwa: the slot grammar (view, settings, now, renderer, slash) and the sandboxed iframe for third-party UI.
- ci: `lib/*` as shared pure code in the boundary test; a tag-triggered release workflow.

## Changed contracts
- New: packages/module-sdk/manifest.schema.json is the manifest contract. test/module-sdk.test.js fails on any module.json key not in it (x- keys are free). Teams adding a manifest key add it to the schema and index.d.ts in the same commit.
