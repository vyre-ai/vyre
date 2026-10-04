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

### Update (same day): the internet mode is built
- Egress proxy `internet` mode (core/runner/egress.js, netguard.js): CONNECT and plain HTTP to PUBLIC addresses only (never loopback, private, link-local, carrier-grade NAT including tailnet addresses, multicast, this machine's own addresses or a mapped form); the proxy resolves the name itself and connects to the address it checked (a name with any private answer is refused); no mail ports; session token as the proxy password; cap and idle timeout per session. Tested with a stub resolver and dial.
- Home, Linux: the launcher starts the proxy with `internet: true` and the sandbox gets HTTPS_PROXY and HTTP_PROXY, so git over https, npm and pip (index over https or http) can work. git over ssh does not use an HTTP proxy and stays blocked. NOT yet run against a real host.
- Lent: `runner.start` takes the Space's `network` ("provider", the default, or "internet" from the lender's connection). With "internet" the session gets the same HTTPS_PROXY. The Space's choice, shown in the lender text: with "internet" the traffic leaves from the lender's address.
- Still to prove: a real `git clone https://`, `npm ci` and `pip install` through it, on a hosted Mac and a test box.
- MEASURED on a test box (scripts/runner-net-proof.mjs, Linux home sandbox with the internet-mode proxy): `git clone https://github.com/...` works; python urllib over https (pypi.org) and plain http both work; loopback, 10.0.0.1 and the cloud metadata address are all refused (403). The proxy answers 407 first because libcurl (git, npm) sends the proxy password only after that challenge. `npm ci` and `pip install` themselves are still not run.

### Real commands through the internet mode (4 Oct, testbox3 Linux; macOS runs are in the hosted workflow artifacts net-home.txt and net-lent.txt)
`node scripts/runner-net-real.mjs home|lent`. Output, Linux home sandbox (proxy internet mode):
```
== git clone https           README                      (cloned octocat/Hello-World)
== npm ci                    is-odd installed: true      (project with a lockfile, made outside the sandbox)
== pip install (venv)        Successfully installed six-1.16.0 / six 1.16.0
== git over ssh (port 22)    git@github.com: Permission denied (publickey).   (tunnel reached; no key in the sandbox, by design)
== refusals                  127.0.0.1, 10.0.0.1, this machine's LAN address, 169.254.169.254, [::1], [fd00::1]: all HTTP 403
```
Linux lent sandbox (runner.start, encrypted workspace, default network): the same five results, plus the tunnels the proxy logged (destination and byte counts only): github.com:443 in 5664 out 1400, registry.npmjs.org:443 in 306605 out 2600, files.pythonhosted.org:443 in 19245 out 1806, pypi.org:443 in 12097 out 1205.
Setting: LENT_NETWORK_DEFAULT = "internet" (runner.js, one constant); the Space says `network: "provider"` or `"internet"`; the lender's cap `lenderCap: "provider"` always wins (effectiveNetwork, tested). Lender line (LENDER_NETWORK_LINE, in status notices): "Sessions you lend can reach the internet from your connection. Sites see your address. You can limit them to the assistant's provider and the space."
Ports: CONNECT to any port except the mail ports 25, 465, 587. git over ssh uses GIT_SSH_COMMAND with a ProxyCommand (core/runner/proxycmd.js). A one-line /etc/passwd for the sandbox user is bound on Linux because ssh needs it.

## Checkpoint I/O (4 Oct, answering the user; numbers in team/0.3/reviews/runner-perf.md)
- **Flushed before reported done?** Before this change, no: the transcript was appended without an fsync and `checkpoint.json` was a plain write. Now the transcript is fsynced before `putCheckpoint`, and the local checkpoint file is temp, fsync, rename, folder fsync. "Done" (`checkpoint` returns true) still means the SPACE acknowledged it; how durable that is belongs to the space's store. The only `putCheckpoint` in the tree is the fake space (testing/fake-space.js): a real space-side store is not written yet, and it must be whole-or-nothing and fsynced (the bench's disk space shows the shape: temp, fsync, rename per file, one checkpoint file last).
- **Full disk:** a transcript line that cannot be written is refused with `disk_full` (file cut back, no half line, the line takes no number); a checkpoint file that cannot be written leaves the old one whole and no temp file; the checkpoint the space holds stands and resumes elsewhere. Measured on a 1 MB tmpfs: refused after 342 lines, 342 complete lines on disk, no torn tail, no stray temp.
- **Own server:** per-turn checkpointing is the runner's (a lent computer or this computer running a space's session). Sessions on the person's own server do not go through it; the runner is the only caller of the checkpoint port in the tree. They rely on Claude's own transcripts on the server's disk (ADR 0030), which are not fsynced by us.
- **SIGKILL mid-checkpoint:** 25 random kills of a checkpointing process on testbox3: every restore came from the last complete checkpoint (turn numbers never went backwards, every file matched its manifest hash, transcript cover verified), and the killed process's folder reopened and checkpointed again each time. A kill does not lose the page cache; a power cut is covered by the fsyncs and the unit tests, not by this measurement.

## Own-server sessions (design 4 Oct, built the same day)
Problem: a session on the person's own server writes Claude's `<id>.jsonl` with plain appends (no fsync). After a power cut the file can end in a torn line or in the middle of a turn, and nothing says which turn was whole. The lent path already has the answer (a checkpoint per turn in the home's store), so the own server uses the same one, with no second format:
- **When:** `thread.finished`, the turn boundary. Never per line.
- **What:** the transcript's complete lines (cut at the last newline), the file fsynced first, appended to the checkpoint store with their numbers, then the checkpoint (turn, seq, state = provider session id, folder, model) as the commit. Project files on the server are the server's own disk and are not versioned (empty manifest): the honest limit.
- **Recover:** `recover()` rewrites the file to exactly the lines of the last checkpoint (temp, fsync, rename, folder fsync) and returns `{ turn, seq, state }` for `--resume`. The caller must make sure no provider process is writing the file.
- **Rewrites:** a provider that rewrote its file (compaction) is not a continuation: the seal fails with `rewritten`, the last checkpoint stands, `runner.seal-failed` says so.
- **Wiring:** `ports.ownServer = { resolve(event) -> { space, session, file, turn, state } | null, port(space) }`. Sessions owns resolve (it knows thread to provider session to file); the home's store port is `store.port(chain)`. Nothing is sealed when the port is absent. Needs from sessions: that resolve, and `recover()` before `--resume` after an unclean stop.
- **Moving:** because the store and the format are the same, a session can continue from the own server on a lent computer and back.
Proved: core/runner/ownserver.test.js (7 unit tests: torn tail, fsync before checkpoint, crash recovery with a restarted process, cursor pickup, rewritten file, nothing sealed, quota) plus the module test, 17 passed on testbox3 with module.test.js and person-chain.test.js. Not yet proved: a real Claude session killed mid-turn on a box (needs the sessions-side resolve).

## Label item (4 Oct)
`person()` in core/runner/index.js no longer decides from a label with the kernel on: `ctx.kernel.chain(meta)` must give hops that are all persons, no viewer chain; no chain (web, setup, unknown device or tailnet label) is refused. The old refusal runs only when `ctx.kernel` is absent (SHIM(legacy labels), goes with the cut-over). Test: core/runner/person-chain.test.js (stub kernel; a real-daemon kernel-on test needs work/kernel-allow, which this branch has not merged). FROZEN in test/person-label-hygiene.test.js (on work/kernel-allow): the runner's one counted line is the shim, so the number stays 1 until the cut-over.
