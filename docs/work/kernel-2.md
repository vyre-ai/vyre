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


# 0.3 kernel store performance (work/kernel-bounded, work/kernel-query)

## Query bar and how it is met
Target: search, list by stage and find by email under 100 ms at p95 at 20,000 records and under 300 ms at 100,000, with 20 people writing. Records' load script on testbox4 (tables in team/0.2/CHAT.md).
- Planner (kernel/store/sqlite-query.js): filter, sort and keyset cursor as one indexed statement, proven equal to the reference by randomized comparison. Equality and range comparisons are bare in a position where NULL and false agree (the first version wrapped them in COALESCE, which no index can serve).
- Aggregates: one GROUP BY when the caller sees every row of the type (`authorizer.rowUniform`), with a covering index per unfiltered grouping.
- Search: FTS5 trigram index per field row (sealed never indexed), ranked in SQL by the reference score (number of fields holding each word, summed), so only the winners are read. A word under 3 characters, a type with more than 1,024 fields, or an index still being built takes the scan. One common word beside rare ones is ranked by `searchTopFast` (see its comment): exact, and tested against the reference on every page.
- Unique-field lookups use the field's expression index, made on first use (one scan, about 0.7 s at 500,000 records, once).

## Hidden rows (the rule)
A restricted member's count by stage and search exclude rows they cannot read. Decision: the visibility predicate is NOT pushed into SQL (a row's answer also depends on owner, project, created_by, rules by resource and presence; a second copy of that logic would be a second authorizer). The GROUP BY runs only when `rowUniform` proves every row of the type gets the caller's same answer; any row-level restriction takes the filtered path, totalled row by row. Search narrows candidates in SQL and every hit passes the gateway's visibility check before it counts toward a page or a total. Test: kernel/gateway/aggregate-visibility.test.js on both stores.

## Non-ASCII cost
SQLite compares bytes; the reference compares UTF-16 code units. Text sort, compare and `contains` over a field that holds any character outside printable ASCII (accented names are normal) are left to the reference code: the rows stream through it, O(rows) per page, correct but not indexed. Equality and the full-text search are unaffected. The fix is a collation in UTF-16 order; not done.

## Known slow paths (exact, not fast)
Search with two or more common words, or a word under 3 characters, ranks by the general SQL (about 0.5 s at 500,000 records). A restricted caller's count by stage is row by row.

# 0.3 rules tools and the log anchor (work/kernel-rules-tools, work/kernel-anchor)

## Rules tools
`rules.list`, `.get`, `.define`, `.test`, `.enable`, `.disable` (and `.remove`, `.propose`, `.accept`, `.dismiss`) in core/rules-tools over the kernel's rule store; shapes in team/0.2/CHAT.md. Off means status `disabled`: the rule stays listed, binds nothing, and the change is an event in the log. `rules.test` writes nothing and says which kind binds an act for an assistant, a member or an assistant acting for a member, for a stored rule or one not yet defined. Time-window rules are 0.3.1.

## Log anchor (BL-2)
The sealing process keeps the newest (seq, head) it was shown, outside the database, forward only. A checkpoint verifies the log, advances the anchor, then is written. A restart compares the log with the anchor; a packaged build refuses to start on a failed check, and the owner's `anchor.reset` (presence) is the way out after a restore. It defends against the database alone being put back. It does not defend against a whole-home restore or someone who holds the sealing folder; a second copy outside the home is a packaging decision for launch.
