# kernel-2 (spaces side of the kernel, 0.3)

Branch work/kernel-spaces (worktree vyre-kernel2-03), off work/kernel. Merge origin/work/kernel often. Tests on testbox3 only (`rsync` to ~/vyre-ci/kernel2, quoted globs).

## Scope
1. Reads on the grants store: members.list/get, invites.get, grants.list filtered. 2. `for(spaceId)`: one kernel per Space. 3. Remote kernel call (kernel/remote). 4. Presence proof pass-through. 5. member.set owner op.
Not mine: K-3 keys, K-2 signing, approval in authorize, surfaces.model.stream, the door, tasks, the module moves, kernel/audit.

## Done
- 1, 4, 5 (kernel/grants/index.js, kernel/remote/proof.js, tests in grants.test.js and remote/proof.test.js).
- 2 and 3 (kernel/spaces, kernel/remote/{wire,server,client,memory-transport}.js, kernel/spaces/spaces.test.js).

## Doing
Step 3 done on my side: windows' kernel-members.js (5ef84ab80) reviewed; the compat face is on work/kernel-spaces-adapter. Waiting for windows to wire index.js and remove the legacy store, and for the review of transferOwner, W-1, W-2 (7c7daac59).

## Done since the gate
- e9c5b7212 KS-1..7 fixed, reviewer-2 PASS. e6721aa10 kernel/remote/wink.js (kernel.call over peer wire). ea1199ef4 acceptProofRequest, proofChainHash, kernel/remote/run/real.mjs.
- Real-machine run (testbox home, testbox2 device, direct then relay with direct firewalled): the kernel-remote-run review in <team-dir>/0.3/reviews. ufw rules removed.

## Next
1. When windows answers: write the adapter + test against a real kernel (createKernel with a presence verifier, as kernel/remote/proof.test.js does), then hand the wiring and store deletion to windows.
2. platform/tailnet: personOf from the identity chain; wrap the peer door's dispatcher with withKernelCall (core/wink/index.js hostPeer serve); wire createSpaceKernels into bootHomeKernel (await spaces.start()).
3. Full suite on testbox: last run 461 tests, 459 pass; reds were kernel/door/sinks.test.js (work/kernel) and kernel/home.test.js (fixed in ea1199ef4).

## Legacy shape still in use (delete when these move to the kernel)
core/spaces/kernel-members-compat.js (branch work/kernel-spaces-adapter) is the createMembers-shaped face of the kernel. Callers still on the legacy shape, on origin/work/spaces:
- core/spaces/index.js: membersFor(id) and the spaces.members.* tools (list, add, set-role, remove, extend, transfer) call lib/spaces/members.js createMembers over the SQLite membershipStore with `actor` and `presence: meta.presence`. They move to createKernelMembers with `kernel: { chain, proof }`.
- core/spaces/store.js: spaces_member (membershipStore), spaces_role_name (roleNames: display names stay local, not authority), spaces_invite (inviteStore).
- core/spaces/index.js createRoleAuthorize({ membership: mstore.get }) and the spaces.membership tool read the legacy store; they read members.get through the kernel handle instead.
- lib/spaces/invites.js: signed invite tokens and personIdFromKey; they move to kernel invites (invites.create, get, accept; ctx.kernel.acceptProofRequest).
- lib/spaces/members.js: createMembers and its rules (kept only for abilitiesOf, roleRank, SpacesError).
windows does the wiring and the store removal; the compat file carries no state.

## Needs from others
- windows: go/no-go on the adapter. tailnet: the dispatcher hook and a Wink (tsnet) run of real.mjs. platform: merge work/kernel-spaces (reviewer-2 passed e9c5b7212; later commits wink.js and run/real.mjs are new, not yet gated).
