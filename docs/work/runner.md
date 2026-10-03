# runner

Branch: work/runner · Worktree: ../vyre-runner-03 · Owner session: runner (0.3)

Scope: let a member run a space's AI sessions on their own computer (team/0.3/DESIGN-local-runner.md): sandboxed
process, encrypted leased workspace, credentials at the point of use, continuous sync with a checkpoint every turn,
automatic placement. All code is in core/runner and sits behind ports (vault, space sync, grants), so the vault,
sessions, tailnet and platform teams plug in the real ones.

## Done
- core/runner/sandbox.js: macOS seatbelt profile, Linux bubblewrap plan (+ shim.js, the in-sandbox loopback to unix-socket forwarder). Deny by default, workspace only, network only to the proxy.
- core/runner/egress.js: reverse proxy with per-request vault fetch, per-session token, granted routes only, CONNECT refused.
- core/runner/lease.js: one-hour key lease in memory, renewed at half life, zeroed on lock, lock on expiry, delete on revoke.
- core/runner/workspace.js: hdiutil AES-256 sparse image (macOS), gocryptfs (Linux). Key goes over a pipe, never argv or disk.
- core/runner/sync.js: transcript stream with outbox, file versions, checkpoint per turn acknowledged by the space, restore on another machine.
- core/runner/placement.js: here, server or wait with a plain reason; limits; pin to server.
- core/runner/runner.js: ties them together; start, stop, lock, revoke, contact, moveToServer.
- core/runner/runner.test.js: 27 tests. Passing on the Mac (temp dirs, hdiutil mounts inside the scratch dir) and on the test box (Linux, bubblewrap + gocryptfs): session runs and the server stays idle, no read outside the workspace, no direct network, no credential in the session, no credential or plaintext transcript on disk (running or locked), revoke deletes, offline-then-revoke deletes on contact, lease expiry locks, resume on another machine from the last whole turn.

## Doing
- Windows spike (restricted job + AppContainer vs WSL2 + bubblewrap), then build the winner.

## Next
1. Windows: write team/0.3/SPIKE-runner-windows.md, build sandbox-win.js and the Windows workspace driver, prove on the Win11 VM.
2. Module wiring: core/runner/module.json and index.js (tools runner.status, runner.place, runner.start, runner.stop, runner.lock, runner.move), grants from the kernel Offer and Use studs.
3. Real ports: vault lease/use over Wink (vault team), space sync port (sessions team), grants (platform).
4. docs/using/local-runner.md, CHANGELOG, ADR number, perf numbers (scripts/perf-check).

## Needs from others
- vault: the lease and use calls below. vault.lease({ space, device }) -> { id, key (base64, 32 bytes, stable per space and device), ttlMs } or { revoked: true }; vault.renew({ id }) -> { ttlMs } or { revoked: true }; vault.use({ ref, session, route }) -> secret string. Per request, over Wink, no caching.
- sessions: the space sync port (appendTranscript, putFile with versions, putCheckpoint, getCheckpoint, getTranscript, getFile) and the continue-elsewhere path that resumes from a checkpoint on the server. Shapes are in core/runner/sync.js and testing/fake-space.js.
- platform: Offer (space_allows, member_accepts) and Use from kernel/contracts/identity.d.ts, and a way to ask "does this member have both grants for this device".
- tailnet: reachability of the space's vault and sync endpoints from the runner.

## Changed contracts
- none yet (core/runner is new; no existing module changed).

## Linux note
Ubuntu 24.04 blocks unprivileged user namespaces for unconfined programs. bubblewrap needs an AppArmor profile that allows `userns` for /usr/bin/bwrap (the test box has one in /etc/apparmor.d/bwrap-vyre). The runner reports this as a plain reason through unavailable().
