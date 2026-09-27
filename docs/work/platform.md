# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## Done
- ADR 0033 accepted by the lead (decisions recorded in the ADR). Inventory in its appendix.
- Team asks sent 2026-09-27: native-core (module settings into the registry: they pick "settings reads manifests" or an internal settings.register), sessions (providers shape frozen by the schema; hooks seam in canUseTool, P4), polish-cli (verb shapes, who writes module.js/update.js), app-design (card shapes, iframe tokens, slot placement), pwa (slot registry + sw caching of /m/<module>/), ci (lib/* in boundaries, the release workflow), chat (renderer slot heads-up).
- P0 written: packages/module-sdk (manifest.schema.json, manifest.js checkManifest, index.d.ts, package.json private, README), test/module-sdk.test.js, docs drift fixes in docs/architecture/spec.md and docs/build/module-contract.md.

## Doing (2026-09-27, after resume from logout 4)
- P0 for batch 4: work/platform e8e3d902 (merges main 7880dfa6; 101/101 targeted) sent to the integrator; the old b4 had the stale 2e6997dd.
- Store limits: work/platform-store-limits 67abc47f = c9f1d630 + a clean merge of native-core 19b92574 (48/48 on testbox). ADOPTED by native-core in 62abf2cf; e2e confirmed in its re-review.
- settings.write e4515fb6: HELD until e2e signs off native-core; only masking secret settings in settings.get is left. Then rebase e4515fb6 on it so settings.write returns the same masked value (asked native-core for a shared mask helper), e2e re-review, then integrator. Then hand to the integrator.
- Hub asks to native-core (hub file + live hand edits, per-key check tool, choices tool, prompt-layer toggle key): re-sent; no answer yet. They fold them into ADR 0035.
- P2 DONE on work/platform 54180bb5 (145/146 on testbox, 1 skip = shellcheck absent; shellcheck clean by hand): core/cli/commands/update.js + core/cli/update/releases.js (Mac), box/vyre update/rollback (box, APK + releases.sign), docs/using/box-care.md, draft docs/build/first-module.md. up.js exports health/waitFor/bring; bring compares against mineOf().version. Not tried end to end with a real npm install and restart; releases stay dry-run (VYRE_RELEASES unset).

- Batch 4 sha sent to the integrator: a1c3fbfc (includes e8e3d902 + 54180bb5, plus the cohesion/tips schema keys and tips.whatsnew in update). Branch CI runs cancelled (lead: Actions saturated; push only finished shas until "pushes open").
- Agreed with cohesion: P1 adds commands.list {surface}, events.catalog (aliases = one-release deprecations, plural canonical), registry.status() rows gain commands/connections/suggest/notices; Render type in index.d.ts. settings.changed resolved value asked of native-core.
- Agreed with docs: they add ctx.declaredTips in core/modules on work/docs (+ index.d.ts).

- ADR 0035 (native-core 799ad333, approved) reviewed: answers the four hub asks. Schema aligned locally in abc5e6da (device/session levels, check/choices {tool}, no device on confirm/security keys). Asked native-core: hub.json in vyre backup (update rollback depends on it), check/choices behaviour when the tool is off or slow, choices naming, rev returned by the store write, enforce session level. settings.write must bump rev once the hub store lands.
- Local, unpushed (pushes paused): 89120047, 339dee40, abc5e6da, this notes commit.

- settings.write: work/platform-settings-write 70242656 (local) merges native-core's local 3ae4fc93 (maskFor), returns secret keys masked; 64/64 settings+modules+presence-bypass on testbox. Waits for e2e's sign-off of native-core, then e2e re-reviews 70242656, then integrator. Later: rev + non-secret value on its settings.changed once the hub store lands.
- Agreed with native-core: settings.changed = rev + value at the changed level for non-secret keys. Schema: secret flag in 172da703 (local).

- ADR 0035 accepted (native-core b95cc4dc) with my five notes answered. Schema matched in 8c74d585 (choicesFrom, session needs tool store). validateDecls patch sent to native-core (scratchpad validateDecls-adr0035.patch; they apply + test). Waiting: their hub store step 1 sha (rev-returning write) to rebase settings.write.
- settings.write 70242656: e2e ok, handed to the integrator (merge after native-core 3ae4fc93).

- Cohesion ADR 0036 asks accepted for P1: meta.call from header X-Vyre-Call-Id (per-thread socket + MCP only, ^[A-Za-z0-9_-]{1,128}$, linking only, never for decisions); registry.status() rows gain use {calls, lastUsed} for person/agent callers only (not module:), in memory, flushed to a kernel table at most once a minute and at stop. Glue module 4 is `waiting`.
- P1 split: the settings-free part (call id, use counts, commands.list, events.catalog, status fields commands/connections/suggest/notices) can start on work/platform now; ctx.settings waits for native-core on main.

- P1 settings-free part DONE 382a8574: meta.call (X-Vyre-Call-Id on session paths), use counts (modules_use, 60 s flush), status fields, ctx.modules.status()/tools(), core/commands (commands.list), core/event-catalog (events.catalog). Sessions must send X-Vyre-Call-Id.
- End-to-end `vyre update` on testbox (npm path, throwaway): update 4.6 s, failed-health rollback 18 to 25 s, --rollback 5.4 s, RSS ~83 MB settled; found and fixed a prune bug (9343bc44). Box wrapper path not run (needs own compose project + no tailscale login).
- Combined targeted run 217 pass / 0 fail / 1 skip (shellcheck). Finished sha for the integrator: 9343bc44.

- Batch 4 red fixed: work/platform-b4fix 97686e1b (checkout build update downloads nothing), with the integrator.
- work/platform b7bbf5d8 (pushed): merges b4d + fix; ADR 0035 schema; P1 settings-free; vault needs.credentials loader diff (ctx.modules.status(), not .list); Render (7 kinds); statusline surface; ADR 0033 theme -> ADR 0035 (appearance.scheme). 393 pass / 0 fail / 16 skip.
- settings.write af5160dd (pushed) on native-core ac34c322: mirror() rev + said(); 74/74. e2e ok BUT held: lands after native-core fixes e2e MEDIUM (secret keys out of hub.json); then add an assert that a secret written via settings.write is not in hub.json in the clear, new sha to integrator.
- Reviewed connectors af11226d meta.firstParty: OK (merge after b7bbf5d8). Vault told to read ctx.modules.status().
- Testbox runs on hold until the integrator reports batch 4 (lead).

- Lead: event renames (PLANNED in core/event-catalog) wait until after 0.1.0; lead routes them then, aliases for one release.

## Next
0. After tonight's deploy (lead): end-to-end `vyre update` on a testbox throwaway stack, never /srv/vyre.
1. When native-core says store limits are in and e2e signs off: hand settings.write e4515fb6 to the integrator.
2. P1 once native-core's settings are on main (loader adopts packages/module-sdk/manifest.js, apiVersion, ctx.api/log/paths.data/settings, watches.on + needs.tools, replaces + disable, registry.status commands, core/cli/commands/module.js with polish-cli review).
3. P2 follow-ups: an end-to-end update on testbox against a throwaway stack (not /srv/vyre) with ci's dry-run dist/ as the release; update.available daily check in vyred (update.auto notify); `vyre box update` from the Mac offering the Mac the same version; the systemd rollback race (restore while systemd restarts vyred).
4. Compile phase: tests and polish for P0/P2; merge first-module.md with writing-a-module.md later (ADR 0033 Section 7).

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
