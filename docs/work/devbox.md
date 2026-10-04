# devbox (the shared dev box keeper)

## Scope
Keep the dev box (testbox, `~/devbox`, unit `vyre-dev`) on the newest combined tree with every team's tools and seeded data, so the app teams walk real screens. Branch work/devbox, off work/chat-dev. Config stays `machine: "server"`. The presence stand-in file lives only in the dev box home. No live vyre.run service is touched.

## Done
- Branch cut from origin/work/chat-dev 600ab0cf6. Merged, in order: kernel-next, spaces (carries core/publish), flows, records, vault-labels, sealing, memory-access, runner, launch-03, wink (already in).
- Conflicts: core/daemon/index.js (flows side, comment only); kernel/gateway/records.js and kernel/store/query.js (both sides kept: kernel-next's fast aggregate and rollback plus records' computed-field checks and addGroup); kernel/grants/roles.js (union: kits and rules actions plus drive.read and drive.write); kernel/gateway/index.js (union: rules touches plus CHECKPOINT_ACTIONS). Generated docs (docs/index.json, docs/reference/*) taken from the dev side; regenerate with `npm run docs:ref` on testbox.

## Doing
Following team heads in team/0.2/CHAT.md (merge, redeploy, post).

## Done (deploy)
- Dev box (testbox, ~/devbox/src, unit vyre-dev) runs this branch; deploy = `rsync -a --delete --exclude node_modules --exclude .git ./ testbox:~/devbox/src/`, `npm ci --omit=dev`, `systemctl --user restart vyre-dev`. Probe a tool with a script that sets the unit's env (HOME=~/devbox/home) and runs `node bin/vyre call <tool> '<json>'`.
- records.dev-seed now adds only what is missing (by name or title); second run adds nothing (test in core/records-tools).
- Stand-in names directory on testbox3 now runs as user unit `vyre-standin-names` from ~/standindir-devbox (this tree), port 8788, `--claims-per-ip 500`; names check answers CORS `*`. Its state is in memory: the restart cleared every claim on it.

## Next
Follow every new head posted in team/0.2/CHAT.md: merge, redeploy, post the new head.

## Needs
- windows: the stand-in directory lost every claim when it was restarted for the new limit; is there a republish for an existing identity and Space name (the dev box's devbox name and its spaces no longer resolve)?
- platform: flows.kit.library is not on any branch (records.kits.library answers).
