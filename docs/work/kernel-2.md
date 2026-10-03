# kernel-2 (spaces side of the kernel, 0.3)

Branch work/kernel-spaces (worktree vyre-kernel2-03), off work/kernel. Merge origin/work/kernel often. Tests on testbox3 only (`rsync` to ~/vyre-ci/kernel2, quoted globs).

## Scope
1. Reads on the grants store: members.list/get, invites.get, grants.list filtered. 2. `for(spaceId)`: one kernel per Space. 3. Remote kernel call (kernel/remote). 4. Presence proof pass-through. 5. member.set owner op.
Not mine: K-3 keys, K-2 signing, approval in authorize, surfaces.model.stream, the door, tasks, the module moves, kernel/audit.

## Done
- 1, 4, 5 (kernel/grants/index.js, kernel/remote/proof.js, tests in grants.test.js and remote/proof.test.js).
- 2 and 3 (kernel/spaces, kernel/remote/{wire,server,client,memory-transport}.js, kernel/spaces/spaces.test.js).

## Doing
Full kernel suite on testbox3; then push, then tell windows and reviewer-2 about 1 and 4.

## Next
Push work/kernel-spaces. Answer reviewer-2. Then: wire `createSpaceKernels` into bootHomeKernel (daemon owns that, ask platform), and the Wink end of the transport port with tailnet (the `peer` shape in kernel/remote/wire.js).

## Needs from others
- tailnet: fill the transport port (`send(space, request)` on the device; hand `serve(request, peer)` the verified peer { device_key_id, person, path }).
- platform: merge after reviewer-2; the daemon builds the registry with `bootHomeKernel`'s kernel as `personal`.

## Changed contracts
- gateway.grants gains `members.{list,get}` and `invites.get`; member.set/member.removed gain `owner_change` and are `vis: "space"` when ownership changed; ctx.kernel gains `for`, `proofFrom`, `proofRequest`; createKernel returns `bindSpaces` and takes `label`.
