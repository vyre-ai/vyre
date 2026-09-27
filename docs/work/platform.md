# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## Done
- ADR 0033 accepted by the lead (decisions recorded in the ADR). Inventory in its appendix.
- Team asks sent 2026-09-27: native-core (module settings into the registry: they pick "settings reads manifests" or an internal settings.register), sessions (providers shape frozen by the schema; hooks seam in canUseTool, P4), polish-cli (verb shapes, who writes module.js/update.js), app-design (card shapes, iframe tokens, slot placement), pwa (slot registry + sw caching of /m/<module>/), ci (lib/* in boundaries, the release workflow), chat (renderer slot heads-up).
- P0 written: packages/module-sdk (manifest.schema.json, manifest.js checkManifest, index.d.ts, package.json private, README), test/module-sdk.test.js, docs drift fixes in docs/architecture/spec.md and docs/build/module-contract.md.

## Doing
- P0 is UNTESTED: testbox is closed until the integrator says "open". Then run: `nice -n 15 node --test test/module-sdk.test.js "test/docs-*.test.js"` (after `npm run docs:ref` if docs-index says stale), pull back regenerated docs, commit, push, and send the sha to the integrator for batch 4.

## Next
1. P1 once native-core's settings are on main: loader adopts packages/module-sdk/manifest.js (add packages/module-sdk to package.json files); apiVersion; ctx.api, ctx.log levels, ctx.paths.data, ctx.settings; watches.on and needs.tools for home modules; replaces (name == replaces) and disable; `vyre module new/list/check/disable/enable`.
2. P2: release workflow (ci) + `vyre update` (Mac and box), rollback restores the DB only on a failed health check inside the update window; SHA256SUMS over TLS from GitHub Releases.
3. P3: module add/remove/update, modules.lock.json, testing harness, templates/module/ (public template repo waits for the lead to ask the user).
4. P4 slots/hooks/senders/apps/themes/prompt; P5 out-of-process host, keyless signing (attestations or sigstore via OIDC first), kernel thinning.

## Needs from others
- integrator: "open" for testbox, then P0 into batch 4.
- native-core: a way for modules' manifest `settings` to join the registry (registry reads `modules.list` manifests, or a `settings.register` internal tool), and `ctx.settings` scoped to the module's own keys.
- sessions: `does.providers` shape stays as on work/sessions; `does.hooks` (brief/enrich/pretool/stop) placement vs the SDK driver's canUseTool.
- polish-cli: `vyre module ...` and `vyre update` verbs next to `vyre config`.
- app-design, pwa: the slot grammar (view, settings, now, renderer, slash) and the sandboxed iframe for third-party UI.
- ci: `lib/*` as shared pure code in the boundary test; a tag-triggered release workflow.

## Changed contracts
- New: packages/module-sdk/manifest.schema.json is the manifest contract. test/module-sdk.test.js fails on any module.json key not in it (x- keys are free). Teams adding a manifest key add it to the schema and index.d.ts in the same commit.
