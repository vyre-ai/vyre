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

- core/runner/module.json + index.js + module.test.js: the runner module (tools status, place, start, stop, lock, revoke, move), ports as seams. docs/using/local-runner.md, CHANGELOG. Reach, docs, boundaries tests green on the test box (109 passed).
- Windows spike written from documentation only (team/0.3/SPIKE-runner-windows.md): nothing measured, the VM was down and the host at load 20-30. Recommends AppContainer + job object, and a gocryptfs-format folder via WinFsp.

## Doing
- Waiting for host load under about 12 and for windows to free the VM, then run the spike experiments and build sandbox-win.js.

## Next
1. Windows: start the VM when free, run experiments 1 and 3b from the spike doc, build sandbox-win.js and the Windows workspace driver, prove on the Win11 VM.
2. Wire the real ports into index.js seams once vault, sessions and platform answer in CHAT.md.
3. Real ports: vault lease/use over Wink (vault team), space sync port (sessions team), grants (platform).
4. docs/using/local-runner.md, CHANGELOG, ADR number, perf numbers (scripts/perf-check).

## Needs from others
- vault: the lease and use calls below. vault.lease({ space, device }) -> { id, key (base64, 32 bytes, stable per space and device), ttlMs } or { revoked: true }; vault.renew({ id }) -> { ttlMs } or { revoked: true }; vault.credential({ ref, session, route }) -> secret string. Per request, over Wink, no caching.
- sessions: the space sync port (appendTranscript, putFile with versions, putCheckpoint, getCheckpoint, getTranscript, getFile) and the continue-elsewhere path that resumes from a checkpoint on the server. Shapes are in core/runner/sync.js and testing/fake-space.js.
- platform: Offer (space_allows, member_accepts) and Use from kernel/contracts/identity.d.ts, and a way to ask "does this member have both grants for this device".
- tailnet: reachability of the space's vault and sync endpoints from the runner.

## Changed contracts
- none yet (core/runner is new; no existing module changed).

## Linux note
Ubuntu 24.04 blocks unprivileged user namespaces for unconfined programs. bubblewrap needs an AppArmor profile that allows `userns` for /usr/bin/bwrap (the test box has one in /etc/apparmor.d/bwrap-vyre). The runner reports this as a plain reason through unavailable().

## 4 Oct update
- Reviewer-2 gate: items 1 to 10, R-11, R-12, S-1 fixed (S-1 at the root: the checkpoint reader runs inside the sandbox, reader.js and readerhost.js). Seccomp deny list added (seccomp.js, Linux x64 and arm64).
- core/runner/ports.js: realPorts() builds the vault, grants and callbacks ports from the sealer client (sealer.lease.issue and renew), gateway.grants.offers (active, onRevoke), vault's leasedUse and the surfaces' device key (R-13: the lease and offer are for this computer, never a caller-supplied name). The module reads ports from a test seam or ctx.kernel.runnerPorts(); the integrator wires the host side.
- sessions' checkpoint state: createRunner({ sessionState }) is stored in the checkpoint, and start({ resume: true }) returns { resumed: { turn, seq, state } }.
- Open: macOS has no process containment (a double-forked helper survives a stop); the Windows run on the VM (mount point fix in progress) and reviewer-2's first Windows gate.

## Windows: out of 0.3, state for 0.3.1 (ruled 4 Oct)
In 0.3 the runner refuses to lend on Windows with one line: "Running a space's work on this computer isn't available on Windows yet. Your sessions run on the space's server." (WINDOWS_LINE in sandbox.js; unavailable(), workspaceUnavailable() and driverFor() all return or throw it, placement never says "here", test in hardening.test.js.) The code below stays on the branch, unreachable unless VYRE_WINDOWS_LENDING=experimental.

What works (measured on the Windows 11 VM, scripts/runner-win/ and core/runner/testing/smoke.mjs):
- AppContainer sandbox (win/sandbox.cs built with the csc that ships in Windows, sandbox-win.js): writes only its granted folders, cannot read another folder or the user profile, no internet, reaches the runner's proxy on loopback once the container is exempt. cmd.exe runs inside it.
- BitLocker VHDX workspace (workspace.js winDriver): created with diskpart, unlocked with a password from stdin and no key file, locks, detaches, wrong password refused, no plaintext in the raw vhdx.
- node.exe starts inside the container, but only from the interactive desktop session. From the VM's ssh session (no desktop) it fails with DLL init error 0xC0000142.

What fails, and fixed on the way:
- CreateProcess error 203 without LOCALAPPDATA in the environment (fixed in planWin); the container also needs traverse plus read-attributes on every folder above its workspace, including a mounted volume's root (fixed with --traverse, removed again by `cleanup` at revoke).
- The latest desktop run: the session process starts and exits at once, no output. Exit-code logging was added (runner emits an `exit` event with code and signal); that run was still in progress when this was ruled. First thing to read in 0.3.1: the exit event and stderr from `testing/smoke.mjs` run as an elevated task in the interactive session (schtasks /it /rl highest).
- Sleep detection locked the workspace as "slept" because a long BitLocker call blocked the event loop for over 90 s. Fixed: sleep is wall time moving while the monotonic clock does not (lease.js, tested).
- Open limit measured: the loopback exemption is per container, not per port, and the Windows firewall cannot narrow it (P10), so a session reaches other loopback services on the machine; only the per-session token guards the proxy.

Administrator rights and the helper-service design (proposed, not built):
- Needs admin: diskpart attach and detach, BitLocker create, unlock and lock, the loopback exemption (once per space), traverse entries on folders such as C:\ and C:\Users (once). Creating the AppContainer profile and running the launcher need none.
- Today the disk operations need admin on every start, unlock and re-open, which means a UAC prompt per session. Not acceptable.
- Design: one helper service, installed at setup (the single UAC prompt, "use this computer for Harlow Legal"), running with only what it needs, exposing a named pipe that only the member's user can open and only these verbs: attach, unlock (key over the pipe, never a file), lock, detach for disks under the runner's own folder; and one-time prepare/cleanup of the container (exemption, ACL entries). No arbitrary commands, no path outside the runner folder. A watchdog in the service locks the disk when the runner's pipe closes.
- A member without administrator rights has no setup, so lending is refused with a plain reason and the session runs on the space's server. Windows Home has no BitLocker: same refusal.
- Reviewer-3's Windows notes to carry: quote CreateProcess command lines correctly (runs of backslashes before a quote); pass paths to PowerShell and diskpart by stdin or -LiteralPath, not interpolated; verify the volume is detached before saying "locked" (the runner already does); show on the card that a session can reach other loopback services.

## Encrypted workspace: what the installer's root helper does once (for launch), and the fallback
Linux, kernel-native fscrypt (core/runner/fscryptctl.py, workspace.js fscryptDriver) is the default and runs at about 1.0x of a plain folder; gocryptfs (FUSE) is 5 to 17x on file-heavy work (team/0.3/reviews/runner-perf.md).
- **The one admin step**, at "use this computer for a space": on ext4 run `tune2fs -O encrypt <device>` for the filesystem that holds the runner's folder (`findmnt -no SOURCE --target <runner folder>` gives the device). Measured: it works on the MOUNTED filesystem, with no remount and no reboot, and an unprivileged probe succeeds right after. It sets a filesystem feature flag; nothing else changes. `fscryptSetupPlan(base)` in workspace.js returns the exact command, or says the folder is already ready.
- **After that, no root at run time:** unlock and lock are plain ioctls (add and remove the key) any user may call; no mount, no helper, no prompt per session.
- **Needs:** Linux 5.4 or newer, python3 (standard library only), an ext4 filesystem (f2fs only offline, `fsck.f2fs -O encrypt`).
- **A filesystem that cannot do it** (btrfs, xfs, zfs, network disks, or the admin step declined): the runner falls back to gocryptfs and says so once, in `runner.status().notice`: "Your files for this space are encrypted with a slower method on this computer's disk format (file-heavy work can take several times longer)." It does not refuse: no lending at all would be worse than slower. gocryptfs also needs `fuse3` and `/dev/fuse`.
- **macOS:** no admin step; an AES-256 sparse bundle (about 1.0x). Windows: out of 0.3.

## Network a sandboxed session has, today and by design (4 Oct, answering the lead)
"Measured" means a hosted run or a test box ran it. Only a LOCAL `git clone` was ever run inside a sandbox; no `git clone https://`, `npm ci` or `pip install` has been run yet (they need network), so those rows say what the profiles allow, not what was observed.

| Sandbox | Internet today | `git clone https://...` | `npm ci` | `pip install` | What the design says |
|---|---|---|---|---|---|
| Home, macOS | Direct and open (allow-default). Loopback, other unix sockets, ::1 and this machine's own LAN addresses are refused. | Should work; ~/.gitconfig is unreadable (home denied), so no identity or credential helper | Should work into the project's node_modules; npm cache is redirected into the session's temp folder; ~/.npmrc (private registries, tokens) is unreadable | Works into a virtualenv inside the project; `--user` and system installs fail (not writable), by design | Open internet stays (no friction); the only walls are the way back into Vyre and the person's files |
| Home, Linux | NONE directly. A private network namespace; the only way out is the runner's proxy, which tunnels only the provider's hosts (`agent.hosts`) | BLOCKED (403 from the proxy) | BLOCKED | BLOCKED | Should be open internet except private and loopback addresses. Not built: the proxy has only a host allow-list mode. SHIP BLOCKER for Linux home sessions |
| Lent, macOS | None. Seatbelt is deny-default; the only reachable address is the runner's proxy port | BLOCKED | BLOCKED | BLOCKED | DESIGN-local-runner section 2 says "network: only to the AI provider and to the space". There is no forward through the home in the code |
| Lent, Linux | None. Private network namespace; the shim reaches the runner's proxy only | BLOCKED | BLOCKED | BLOCKED | Same as above |

Named ship blockers: (1) lending (both systems) cannot install packages or clone from a host, because the proxy routes only the provider and the space; (2) Linux home sessions have no internet beyond the provider's hosts. Both come from one missing piece: an "internet" mode in the egress proxy (public destinations only, by CONNECT and plain HTTP, with the session token, refusing loopback, private, link-local and the machine's own addresses, resolving the name itself so a name cannot rebind to a private address). Home Linux would use it by default. For lending the choice is the Space's: provider-and-space only (today), or the internet from the lender's connection. A forward through the home's own connection needs a Wink forward and is not built.
Two honest limits of an open internet in a session: it can send the project's data anywhere, and on a lent computer the traffic leaves from the lender's address. Both belong in the one plain line in the lender text and the settings card.
