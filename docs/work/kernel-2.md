# kernel-2 (spaces side of the kernel, 0.3)

Branch work/kernel-spaces (worktree vyre-kernel2-03), off work/kernel. Merge origin/work/kernel often. Tests on testbox3 only (`rsync` to ~/vyre-ci/kernel2, quoted globs).

## Scope
1. Reads on the grants store: members.list/get, invites.get, grants.list filtered. 2. `for(spaceId)`: one kernel per Space. 3. Remote kernel call (kernel/remote). 4. Presence proof pass-through. 5. member.set owner op.
Not mine: K-3 keys, K-2 signing, approval in authorize, surfaces.model.stream, the door, tasks, the module moves, kernel/audit.

## Done
- 1, 4, 5 (kernel/grants/index.js, kernel/remote/proof.js, tests in grants.test.js and remote/proof.test.js).
- 2 and 3 (kernel/spaces, kernel/remote/{wire,server,client,memory-transport}.js, kernel/spaces/spaces.test.js).

## Doing
Step 3 with windows: asked them (CHAT/message) whether to write lib/spaces/kernel-members.js (a createMembers-shaped adapter over kernel.for(space).gateway.grants) on a branch off origin/work/spaces. Waiting for their go.

## Done since the gate
- e9c5b7212 KS-1..7 fixed, reviewer-2 PASS. e6721aa10 kernel/remote/wink.js (kernel.call over peer wire). ea1199ef4 acceptProofRequest, proofChainHash, kernel/remote/run/real.mjs.
- Real-machine run (testbox home, testbox2 device, direct then relay with direct firewalled): the kernel-remote-run review in <team-dir>/0.3/reviews. ufw rules removed.

## Next
1. When windows answers: write the adapter + test against a real kernel (createKernel with a presence verifier, as kernel/remote/proof.test.js does), then hand the wiring and store deletion to windows.
2. platform/tailnet: personOf from the identity chain; wrap the peer door's dispatcher with withKernelCall (core/wink/index.js hostPeer serve); wire createSpaceKernels into bootHomeKernel (await spaces.start()).
3. Full suite on testbox: last run 461 tests, 459 pass; reds were kernel/door/sinks.test.js (work/kernel) and kernel/home.test.js (fixed in ea1199ef4).

## Needs from others
- windows: go/no-go on the adapter. tailnet: the dispatcher hook and a Wink (tsnet) run of real.mjs. platform: merge work/kernel-spaces (reviewer-2 passed e9c5b7212; later commits wink.js and run/real.mjs are new, not yet gated).
