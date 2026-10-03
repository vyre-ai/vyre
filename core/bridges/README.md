# bridges

The one way a Space shares with another. Thin wiring over `lib/spaces/bridges.js` (the lifecycle, pure), `lib/spaces/authz.js` (a role authorize with the kernel's shape) and `lib/spaces/members.js`. Contract: SPEC-core-contract section 10.

## The actions this module declares

`BRIDGE_ACTIONS` from the lib, listed in `module.json` under `does.actions`: `references.share`, `references.resolve`, `views.share`, `views.read`, `records.copy`, `copy.sealed`, `events.project`, `kits.install`, `tasks.continue`, `bridges.accept`, `bridges.revoke`.

## Tools

Person tools run for the person's own surfaces and devices. The `anyone` tools build a chain from the verified caller, so a model in the chain is held or refused by authorize (an outward act is held, `copy.sealed` is refused). `modules` tools are internal.

| Tool | Reach | Input |
|---|---|---|
| `bridges.propose-view` | person, presence | `person, source, destination, expires_at, type, fields[], filter?, sort?, max_red?, owner_confirmed?, sealed_placeholder?, destination_cache?` |
| `bridges.propose-reference` | person, presence | `person, source, destination, expires_at, types[], label_fields?, cache_label?, max_red?` |
| `bridges.propose-projection` | person, presence | `person, source, destination, expires_at, types[], fields[], subject_prefix?, free_text_confirmed?, max_red?` |
| `bridges.accept` | person | `person, bridge` |
| `bridges.revoke` | person | `person, bridge, space?, reason?` |
| `bridges.list` | person | `person, space?` (both sides) |
| `bridges.get` | person | `person, bridge, space?` |
| `bridges.view.read` | anyone | `person, share, space?, filter?, sort?, limit?, cursor?` |
| `bridges.resolve` | anyone | `person, space, urn` |
| `bridges.copy` | anyone, presence only with `copy_sealed` | `person, urn, toSpace, destType?, copy_sealed?[]` |
| `bridges.project` | modules | `projection, event` |
| `bridges.kit.export` | person | `definitions` |
| `bridges.kit.plan` | person | `person, space, kit` |
| `bridges.kit.install` | person | `person, space, kit, approved_plan_hash` |
| `bridges.continue` | anyone | `person, fromSpace, toSpace, summaryRefs[], title?` |
| `bridges.session.policy` | modules | `person, spaces[]` |
| `bridges.merge.links` | person | `person, spaces?[]` |

`person` is the person key. Until the kernel builds chains, the module builds one from it and the caller (`personChain` in `lib/spaces/authz.js`) and checks it against `spaces.membership`; nothing a caller sends names a model hop.

Errors carry the lib's codes (`not_accepted`, `expired`, `revoked`, `forbidden`, `sealed`, `wrong_space`, `needs_presence`, `bad_input`, `not_found`) plus `held` for an Ask that waits for a person. A share you are not part of, or one that does not exist, answers `not_found: no such share`. A reference you may not read answers the same unresolved chip as one that does not exist.

## What it calls (the seams)

All through `ctx.call`; a missing one answers in plain words and never crashes.

- `spaces.membership {space, person}` returns a Membership or null (fails closed). Also `spaces.list {person}` (rows of `{space|id, name, color, link}`), `spaces.policy {space}` (`{inference, secrets, allow_copy}`), `spaces.ask {space, card}`.
- The record reader per Space, the `records.*` tools: `read {space,type,id}` -> `{record}`, `query {space,type,spec}` -> `{rows,next_cursor}`, `create {space,type,id,data,meta}`, `schema {space,type}` -> `{schema}`, `state {space}`, `define {space,diff}`. With none, `bridges.view.read` says `records are not installed in that space`. The share's own row is the offer and acceptance record when records are absent.
- `tasks.create {space,title,source,doer,inputs,output,how}`. Without it `bridges.continue` saves a pending continuation in `bridges_continuations` and says so in its `note`.

## Storage and events

SQLite tables `bridges_items` (one row per bridge, body JSON) and `bridges_continuations`. Events go to both Spaces' logs, each payload carrying `space` plus ids, counts and field names, never values: `view|reference|projection` x `proposed|accepted|revoked` (and `view.read`, `reference.resolved`, `projection.delivered`), `record.copied`, `kit.installed`, `task.continued`, `bridge.revoked` (one per Space, once).

## The device merge (for native-core)

No server joins data across Spaces. `bridges.merge.links {person}` returns `[{ space, name, color, link }]` for each Space the person belongs to now (expired temps and removed members drop out). The device then:

1. Opens each `link` through that Space's own gateway with the person's own key, as `{ space, name, color, read(op) }`.
2. Calls `mergeRead(sources, op, { sort, groupBy, limit })` from `lib/spaces/merge.js` (also `mergedSearch`, `mergedNow`). Each row comes back tagged `_space {id, name, color}`; a source that fails or was revoked shows as `unavailable` or `revoked` and the rest still show. The result is for the person's eyes only.
3. To hand a merged view to an assistant, calls `sessionFromMerge(merged, residencyBySpace)`, or asks `bridges.session.policy` (drafts only for writes, an Ask naming every Space, labels from all sources, the strictest residency).
4. Keeps one encrypted cache per Space with `createSpaceCache({ spaceId, deriveKey, grantId })`, the key tied to that Space's grant.

On revoke the module emits `bridge.revoked` into both Spaces' logs. A device that follows a Space's log calls `cache.onRevoke({ grantId })` (the bridge id) or `onRevoke({ space })` and the cache is emptied and refuses further use. Shared labels are cached on the device only when the result says `cacheable`; the module keeps no label cache of its own.
