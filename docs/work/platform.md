# platform

Branch: work/platform · Worktree: ../vyre-platform · ADR 0033

## Scope
Hackable Vyre (ADR 0033): a stable, versioned module API; extension points for every part; user modules and overrides that survive updates; `vyre update` from GitHub releases; `vyre module new/add/remove`; the boundary ratchet toward a thin kernel.

## Done
- ADR 0033 draft (docs/adr/0033-hackable-vyre.md) with the inventory in its appendix; nav entry; ADR number claimed in docs/work/README.md.

## Doing
- Waiting for the lead's OK on ADR 0033 before any code.

## Next
1. Phase 0: core/modules/manifest.schema.json, packages/module-sdk types skeleton, docs drift fixes (SPEC requires example, shows.deck, latestId, the entry-file type).
2. Phase 1 (after native-core settings is on main): loader-only changes in core/modules (apiVersion, schema, ctx.api/log levels/paths.data/settings, watches.on, needs.tools, replaces, disable) and `vyre module new/list/check/disable/enable` with polish-cli.
3. Phase 2: release workflow + `vyre update` (Mac and box) with ci and box-deploy.
4. Phases 3 to 5 per the ADR build plan.

## Needs from others
- lead: OK on ADR 0033 and its open questions (0.1.0 start, signing key, iframe UI, template repo).
- native-core: a way for modules' manifest `settings` to join the registry (registry reads `modules.list` manifests, or a `settings.register` internal tool), and `ctx.settings` scoped to the module's own keys.
- sessions: `does.providers` shape stays as on work/sessions; `does.hooks` (brief/enrich/pretool/stop) placement vs the SDK driver's canUseTool.
- polish-cli: `vyre module ...` and `vyre update` verbs next to `vyre config`.
- app-design, pwa: the slot grammar (view, settings, now, renderer, slash) and the sandboxed iframe for third-party UI.
- ci: `lib/*` as shared pure code in the boundary test; a tag-triggered release workflow.

## Changed contracts
- None yet (design only).
