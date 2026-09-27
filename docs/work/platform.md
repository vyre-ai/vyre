# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## Done
- ADR 0033 accepted by the lead (decisions recorded in the ADR). Inventory in its appendix.
- Team asks sent 2026-09-27: native-core (module settings into the registry: they pick "settings reads manifests" or an internal settings.register), sessions (providers shape frozen by the schema; hooks seam in canUseTool, P4), polish-cli (verb shapes, who writes module.js/update.js), app-design (card shapes, iframe tokens, slot placement), pwa (slot registry + sw caching of /m/<module>/), ci (lib/* in boundaries, the release workflow), chat (renderer slot heads-up).
- P0 written: packages/module-sdk (manifest.schema.json, manifest.js checkManifest, index.d.ts, package.json private, README), test/module-sdk.test.js, docs drift fixes in docs/architecture/spec.md and docs/build/module-contract.md.

## Doing
- P0 for batch 4: the integrator should take the newest work/platform sha (it passes over work/native-core's tree too).
- settings.write on work/platform-settings-write e4515fb6 (worktree ../vyre-platform-sw), off native-core 390ff807, 15/15. HELD: lands only after native-core clears e2e's re-review; e2e reviews it too (lead, 2026-09-27).
- SECURITY finding sent to lead, native-core and e2e: a home module's setting store ({tool} runs as the person, {config} any path, {claude} permissions) reaches past its rows when the person changes it. Proposed fix for non-core modules: own tools called as module:<name>, config path "<module>." prefix, no claude store. Mirrored in packages/module-sdk checkManifest (firstParty option; repo manifests checked as first-party). Waiting on native-core: do they fix it or do I send a diff.

## Next
1. P1 once native-core's settings are on main: registry.status() rows (GET /v1/modules) gain `commands` from the manifest while running (polish-cli's dispatcher reads them; input schemas come from the existing tools listing); loader adopts packages/module-sdk/manifest.js (add packages/module-sdk to package.json files); apiVersion; ctx.api, ctx.log levels, ctx.paths.data, ctx.settings; watches.on and needs.tools for home modules; replaces (name == replaces) and disable; `vyre module new/list/check/disable/enable`.
2. P2: release workflow (ci) + `vyre update` (Mac and box), rollback restores the DB only on a failed health check inside the update window; SHA256SUMS over TLS from GitHub Releases.
3. P3: module add/remove/update, modules.lock.json, testing harness, templates/module/ (public template repo waits for the lead to ask the user).
4. P4 slots/hooks/senders/apps/themes/prompt; P5 out-of-process host, keyless signing (attestations or sigstore via OIDC first), kernel thinning.

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
