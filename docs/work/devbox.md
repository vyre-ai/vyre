# devbox (the shared dev box keeper)

## Scope
Keep the dev box (testbox, `~/devbox`, unit `vyre-dev`) on the newest combined tree with every team's tools and seeded data, so the app teams walk real screens. Branch work/devbox, off work/chat-dev. Config stays `machine: "server"`. The presence stand-in file lives only in the dev box home. No live vyre.run service is touched.

## Done
- Branch cut from origin/work/chat-dev 600ab0cf6. Merged, in order: kernel-next, spaces (carries core/publish), flows, records, vault-labels, sealing, memory-access, runner, launch-03, wink (already in).
- Conflicts: core/daemon/index.js (flows side, comment only); kernel/gateway/records.js and kernel/store/query.js (both sides kept: kernel-next's fast aggregate and rollback plus records' computed-field checks and addGroup); kernel/grants/roles.js (union: kits and rules actions plus drive.read and drive.write); kernel/gateway/index.js (union: rules touches plus CHECKPOINT_ACTIONS). Generated docs (docs/index.json, docs/reference/*) taken from the dev side; regenerate with `npm run docs:ref` on testbox.

## Doing
Deploy of the merged tree to the dev box.

## Next
Follow every new head posted in team/0.2/CHAT.md: merge, redeploy, post the new head.

## Needs
Nothing yet.
