# sessions-spaces (sessions teammate, Vyre 0.3): sessions under Wink

Branch work/flows, worktree vyre-sessions-03. Code in core/space-sessions/ (not registered in today's registry until the gateway lands).

## Scope
Wink design sections 5 and 7: a session belongs to one Space; it may run on a member's own computer when both grants exist; its working copy is encrypted and syncs back continuously; a checkpoint at every turn lets it move between machines; "Continue in another space" starts a new session from an approved, stripped summary.

## Done (3 Oct)
- place.js: `placeSession({space, person, device, session_owner})` returns `{where, reason, grants}`. The Space's offer (action `sessions.run-on-member-device`, issued by an admin) and the member's accept (`sessions.host-for-space`, issued by the person, for that one device) are kernel grants; `offerGrant` and `acceptGrant` build them. Missing, expired, revoked, another space's, a non-admin offer, another person's device or session all mean the server.
- workcopy.js: AES-256-GCM blobs named by keyed hash, key from HKDF over a key the vault releases at use (memory only), path confinement, debounced push per path, clash keeps the Space's version and stores ours as a sibling, a machine that lost the lease cannot write, a handed-out credential cannot be written into the copy, hydrate with hash check, manifest hash, wipe on close.
- spacestore.js: reference Space side: file versions, lease with fencing token and expiry, checkpoints.
- checkpoint.js: `turnDone` (push files, then checkpoint with transcript delta, manifest hash, tasks, meta, fenced by the token), `resume` (lease, hash checks, hydrate, manifest match, gives the lease back on failure).
- continue.js: propose (summarize, strip source-only facts, door sanitize, continue_in_space task), edit (new hash voids approval), deliver (only after done and approved for the exact hash, once; old session unread-only).
- index.js: `createSpaceSessions` registry enforcing space on every call.
- 17 tests on fakes (temp dirs).

## Doing
Nothing in flight.

## Next
1. Register the module and its tools (sessions.create, sessions.checkpoint, sessions.resume, sessions.continue.*) when the gateway lands; actions `sessions.create`, `sessions.read`, `sessions.continue` go into the registry.
2. Replace spacestore.js with the Space's Drive and records over Wink transport; real timers and a lease renewal loop in the runner.
3. Wire `summarize` and `sanitize` to the inference door (fork C) and `ask` to kernel tasks.

## Needs from others
- platform: actions `sessions.create`, `sessions.read`, `sessions.continue`, `sessions.run-on-member-device`, `sessions.host-for-space` in the registry; `ask.request` accepting source `continue_in_space` from a service chain (kernel SOURCES today allows only manual, assistant_request, flow_step).
- vault: `release({purpose:"workcopy"})` and a per-use credential door.
- wink: the transport (push, pull, manifest, lease) between a member's computer and the Space.
- tailnet/wink: `deviceOwner(device)` and `isAdmin`.

## Changed contracts
None.
