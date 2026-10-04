# devbox (the shared dev box keeper)

## Scope
Keep the dev box (testbox, `~/devbox`, unit `vyre-dev`) on the newest combined tree with every team's tools and seeded data, so the app teams walk real screens. Branch work/devbox, off work/chat-dev. Config stays `machine: "server"`. The presence stand-in file lives only in the dev box home. No live vyre.run service is touched.

## Done
- Branch cut from origin/work/chat-dev 600ab0cf6. Merged, in order: kernel-next, spaces (carries core/publish), flows, records, vault-labels, sealing, memory-access, runner, launch-03, wink (already in).
- Conflicts: core/daemon/index.js (flows side, comment only); kernel/gateway/records.js and kernel/store/query.js (both sides kept: kernel-next's fast aggregate and rollback plus records' computed-field checks and addGroup); kernel/grants/roles.js (union: kits and rules actions plus drive.read and drive.write); kernel/gateway/index.js (union: rules touches plus CHECKPOINT_ACTIONS). Generated docs (docs/index.json, docs/reference/*) taken from the dev side; regenerate with `npm run docs:ref` on testbox.

## Doing
Stopped on the usage limit (4 Oct). Trunk origin/work/devbox is e9b23e36b: boot-gated, lint clean, deployed on the dev box, smoke pass=123 fail=0 hung=0. Gate each head in this order: merge with --no-commit, `scripts/devbox-merge-check.py --worktree`, commit, `scripts/devbox-merge-check.py HEAD`, regenerate docs on a test box (`npm run docs:ref`, copy back ALL of docs/reference and docs/index.json), `scripts/devbox-lint.sh <old trunk>`, `scripts/devbox-boot-check.sh testbox2`, docs tests, push, deploy, `scripts/devbox-smoke.sh` on testbox3. A pre-commit hook in this worktree refuses conflict markers (worktree core.hooksPath).

## Queue (heads as last sent, check origin for newer; one head per branch)
1. work/wink-session 1e3c6c587 (wink-2, TK-1 fixed: first-owner-wins; the earlier 07cf8acb0 broke 5 paired-session tests in test/wink.test.js, fixed by 1e3c6c587 per wink-2, not rerun by me). Run `node --test --test-name-pattern="a revoked session id" test/wink.test.js` and the paired-session and PS-4 tests before pushing. The lead closes the advisory once it is on trunk, so send the lead the sha.
2. work/test-integrity a2c268fac (platform-2: wink.test.js split into wink.test.js and wink-paired.test.js, known-red cap 24).
3. work/app-wire 1d2875d7b (plugin grant card; ui-ux copy), 3700b6236 before it.
4. work/vault-labels 78dff2423 (replaces 824979454 and c27d06619).
5. work/ui 2a20cf19d (native-core; merges fed6426ea with its 4 conflicts resolved; on the newer trunk keep trunk lines and ui's additions, owner.pin and esig in serverpair.d.ts).
6. work/kernel-default-on-k2 0853d1a6a (kernel-2, module trust follows build kind) only when integrator says "kernel-on adds none" or the reds have owners; still 48 files red with kernel on, not module trust.
7. work/records, work/memory-split, work/runner: take any newer head after e9b23e36b.
HELD: kernel-default-on 1263898fa, memory-shim-removal, tailnet's work/join-e2e (scratch, never to trunk), reviewer-3's runner findings CF-1/CF-2/CF-3 (box uid confinement is not to be called confined in release notes until runner fixes them).
Open: test/wink.test.js (or wink-paired) leaks timers and does not exit (platform-2 and wink-2 in CHAT.md); agent start on the dev box under bwrap needs runner's script-agent bind (54f4b2fe5 is on trunk, re-check: `vyre call threads.start` with agent on the dev box).

## Done (deploy)
- Dev box (testbox, ~/devbox/src, unit vyre-dev) runs this branch; deploy = `rsync -a --delete --exclude node_modules --exclude .git ./ testbox:~/devbox/src/`, `npm ci --omit=dev`, `systemctl --user restart vyre-dev`. Probe a tool with a script that sets the unit's env (HOME=~/devbox/home) and runs `node bin/vyre call <tool> '<json>'`.
- records.dev-seed now adds only what is missing (by name or title); second run adds nothing (test in core/records-tools).
- Stand-in names directory on testbox3 now runs as user unit `vyre-standin-names` from ~/standindir-devbox (this tree), port 8788, `--claims-per-ip 500`; names check answers CORS `*`. Its state is in memory: the restart cleared every claim on it.

## Next
Follow every new head posted in team/0.2/CHAT.md: merge, redeploy, post the new head.

## Needs
- windows: the stand-in directory lost every claim when it was restarted for the new limit; is there a republish for an existing identity and Space name (the dev box's devbox name and its spaces no longer resolve)?
- platform: flows.kit.library is not on any branch (records.kits.library answers).

## Localhost-ssh check (lead, 4 Oct): who counts as the owner over ssh
On a dev box with the presence stand-in file, a CLI under a root-owned sshd or login counts as the owner. The accepted residual: a process that holds a key authorized for the machine could ssh to itself and run `vyre call` as the owner. The check is `scripts/devbox-ssh-check.sh` (no secrets printed): passwordless ssh to localhost, 127.0.0.1 and the hostname must be refused, no key held in the user's ssh folder may also sit in that user's authorized keys, and a forwarded agent is flagged. Run on every deploy.
- Result 4 Oct on all six test boxes (the user vyred and the agent sessions run as is the same login on each): RESULT clean on all six. Each refused ssh to localhost, 127.0.0.1 and its own hostname. Each has one authorized key, from outside; none holds a private key that is authorized there. One box holds a deploy key file that is not in its own authorized keys. No agent is forwarded in a plain ssh from the Mac.
- Watch: ssh from the Mac with -A (agent forwarding) would put an authorized key in reach of any agent session started from that shell; do not use -A to a test box.

## Files where I chose a side (owners: please check)
Conflict resolutions made on this trunk, newest wins notes first. A side chosen here can have dropped a line the other side added; the lead found one (core/recall/indexer.js, flows' humanOf line, taken from the dev side in round 2 and restored by work/flows 699fcace8).
- core/recall/indexer.js: dev side taken in round 2 (lost flows' `human === null ? t.human : (human ? 1 : 0)`); fixed by flows 699fcace8.
- core/daemon/index.js: callerFacts and the `measured` ancestry (kept the definite-outside rule, kernel-reg's person-session fact, kernel-lb1's {inside, outside}); `measured`, never `ancestry`, because a const of that name sits in the dead zone of the imported function.
- core/modules/index.js: classReach(gateCaller, ...) and callerAllowed with tool and setup-tools arguments (reach-classes) kept with agentOnly (memory-access) and the `defaulted` person-only default (kernel-reg); daemon-needs list is a union.
- kernel/gateway/records.js and kernel/store/query.js: both sides (kernel-next's one GROUP BY aggregate, rollback of a refused define, page checks; records' computed-field checks, refuseComputed, addGroup); later taken from records' own resolution (006c64da2).
- kernel/grants/roles.js: union of kits.*, rules.* and drive.read and drive.write.
- kernel/gateway/index.js: CHECKPOINT_ACTIONS import restored once, then deduplicated.
- kernel/seal/process.js: vault's own file (own devSwitch, no devbuild import) plus the `unattestedAllowed` export that kernel/devbuild.test.js imports.
- core/wink/pairing.js and pairing.test.js: wink-labels' askNameOf (lead's ruling), not tailnet's earlier one.
- core/network/wink.js, core/relay/index.js: wording of the same behaviour from reach-classes.
- core/system/module.json, core/recall/module.json: the dev side's reach entries plus kernel-reg's `reads` arrays.
- package.json test:windows: kernel-lb1's list plus core/sessions/windows-no-shell.test.js.
- Generated docs (docs/index.json, docs/reference/*): dev side taken at every conflict, regenerated with `npm run docs:ref`.
- Audit run 4 Oct (script over every trunk merge, lines a parent added that the result lacks, files both sides changed): mostly later-superseded app files. To check by owners: core/spaces/index.js (a `membershipOf(id, K.owner, meta)` line added by a spaces merge, absent now: windows), core/work/module.json `needs.kernel` (present), core/memory tests that call callerFacts with `{ inside: false }` (assistant: they predate the `outside` field).
