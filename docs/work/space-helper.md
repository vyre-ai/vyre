# Space helper (launch, 4 Oct): the root side of a Space's Twenty store

Needs: docs/work/records.md on work/records, "Root helper for a real box". Gate: reviewer-3, because this runs as root. Status: CODE on work/launch-03 (box/vyre `space-helper`, `space-helper-run`, `admin`; test/space-helper.test.js). Design confirmed by reviewer-3 and reviewer-2 (by reading) before code.

## What it must do, and nothing else

On a box the daemon runs in a container with no root and no Docker of its own. Per Space it needs (1) its Twenty compose project started, stopped and removed, and (2) three firewall rules applied and removed. Nothing else.

## Where it runs and how it is asked

On the host, as root, in the pattern the updater already uses (box/vyre `update-from-request`, root-owned run copies, ADR 0029): a root systemd path unit watches a request folder that root owns and the daemon's uid can only add one small file to; no socket and no arguments, so a request can only say what the fixed grammar below allows.

- Request: one line, `<verb> <space>` where verb is `up`, `stop`, `down` or `firewall-add`, `firewall-del`, and space matches `^[a-z][a-z0-9-]{0,30}$`. Anything else is refused and logged. The daemon never sends a path, an image, a subnet, a uid, a flag or a compose file.
- Answer: a status file root writes (state, message), read-only to the daemon, like the updater's.
- Caller: the file must be created by the daemon's own uid (checked with stat), mode 0600 or tighter, and a request from any other uid is ignored and logged.

## How each verb is made safe

1. The compose file is never read from the caller's folder. Root regenerates the expected file from the Space name, the pinned tag and the memory profile, using the box image's own `composeFile()` (stores/twenty/provision.js) run as `docker run --rm --network none` of the image digest root recorded at install (the same digest the updater verified), and compares it byte for byte with the file in `<home>/kernel/twenty-home/spaces/<name>/twenty/compose.yml`. A difference is a refusal. Root then runs compose on ITS OWN copy of that generated file, from a root-owned directory, with the project name `vyre-<name>-twenty`.
2. The only compose commands: `up -d --wait`, `stop`, `down` (and `down -v` only for a deleted Space). No `-f` of any other file, no `--project-directory`, no `--env-file` outside the root-owned copy, no `exec`, no `run`.
3. Backup and restore (`docker run alpine tar` in records' list) are NOT in this first helper; they run as the daemon through the docker-api proxy once that policy allows exactly those volumes. If records insists they need root, they come as two more fixed verbs with the same regeneration rule.
4. Names: every container, network and volume it touches must start with `vyre-<name>-twenty`. It never touches /srv/vyre, the daemon's own container or any other project.
5. Firewall: superseded by "Firewall (reviewer-3 2)" in the first revision below and by RH-3 and RH-4 in Revision 2. The rules live in the vyre container's own namespace; there is no host OUTPUT or DOCKER-USER rule.
6. Every action and every refusal is appended to a root-owned log (`/var/log/vyre-space-helper.log`), and the daemon sees the one-line result.

## Open points for the review

- Does reviewer-3 accept regenerating the expected compose file inside the pinned image (root runs a container with no network and no mounts, reads its stdout) rather than carrying a second copy of `composeFile()` in shell?
- The agents are uids 2000 to 2063 inside the vyre container, whose network namespace is its own; the OUTPUT rule on the host does not see them. The rule shapes in `firewallRules()` have to be checked against the new own-network box (no shared tailscale namespace any more); records and vault to confirm which chain the agents' traffic crosses.
- Windows and Mac have no such helper: a Mac or Windows home that runs Twenty is a separate question (records says Linux only).

## Revision after the reviews (reviewer-3: space-helper-design.md, reviewer-2: root-helper.md, 4 Oct)

Rulings taken as written. The design above stands except where this section changes it.

Request handling (reviewer-2 B-1 to B-6, B-9):
- A spool, not a single file: the daemon adds `req-<32 hex>` to a folder root owns and the daemon uid can only create files in. Root CLAIMS a request by renaming it into a root-only folder first, then `lstat`s that copy (regular file, daemon uid, link count 1, at most 64 bytes) and reads only that copy. A FIFO or a link is refused and removed; the lock is never held while reading.
- The answer is a status file per request id (`status/<id>`), written `running` then the result with the id and the time, after the request is consumed and before it is acted on.
- The text is parsed whole with an anchored pattern, one line only (no `tr -d` of newlines): `^(up|stop|down|firewall-add|firewall-del) (<name>)$`, the name passed quoted after `--`.
- The daemon's uid proves only that it asked, so root keeps its own record of accepted Spaces (a list, with a cap on how many), refuses a Space not in that record (including a request left in the spool across a reboot), refuses `firewall-del` while the project's containers run, and `purge` (down -v) is its own verb that needs presence evidence or is left out.
- The spool and the log are capped and rate limited; the service sets `StartLimitIntervalSec=0` so a flood cannot disable the path unit, and `stop`, `down` and `firewall-del` keep their own lane so a flood of `up` never blocks cleanup.
- The unit's environment is fixed (reviewer-2 B-9), nothing is inherited.

Compose (B-7, B-8, reviewer-3 1): root touches nothing under the daemon's home and compares nothing against the daemon's compose file. It regenerates the expected file with the pinned image (digest read from a root-owned state file, run unprivileged, read-only, no network, no mounts), lints it (no privileged, no host mounts, no ports, no network_mode, no env_file, named volumes only, images by the digest root recorded), writes it into one root-owned folder with checked parents, and runs compose only from that copy. The memory profile and tag come from root's own config or a closed enum, never the request.
- Project and resource matching is exact by the compose project label, not a name prefix (`foo` and `foo-twenty-bar` must not collide).

Firewall (reviewer-3 2): the host OUTPUT and DOCKER-USER owner rules do not work for agents inside the vyre container (their packets are forwarded, and the owner match only sees local sockets of the namespace that owns them). The rules go INSIDE the vyre container's own network namespace: `nsenter -t <pid from docker inspect> -n`, chain OUTPUT, `--uid-owner 2000-2063`, destination the store subnet read from `docker network inspect`, inserted with `-I OUTPUT 1` (never appended), checked with `-C` first, ip6tables too, and verified with a probe run as uid 2000 that must be refused; a failed probe fails the request up to the daemon. Removal takes out exactly the rules carrying `vyre:<name>`.

Log and status carry no path and no secret. Where the Space's secrets come from, and whether the host CLI needs the same verbs by sudo, are still open (reviewer-2); I propose neither: secrets stay the daemon's, the helper never sees them (Twenty's own `.env` is generated by the regenerated compose from root-owned inputs), and the host CLI uses `sudo vyre space ...` only if records asks.

Test list (both reviews): claim by rename; a FIFO, a link, an oversize file and a second link are refused; two concurrent requests both answered by id; an unknown Space refused; a request left across a reboot refused; `firewall-del` refused while containers run; the generated compose differing in one byte refused; each forbidden compose key refused; a name that prefix-matches another project refused; the firewall probe failing makes the request fail; applying twice changes nothing; flood limits and the cleanup lane. No code until reviewer-2 and reviewer-3 confirm this revision.

## One more closed verb: `fscrypt-enable` (runner's admin step, opt-in)

runner's kernel-native fscrypt for a lent workspace needs one root step on ext4: `tune2fs -O encrypt <device>`, run once on the mounted filesystem, no remount, no reboot (`fscryptSetupPlan(base)` in core/runner/workspace.js on work/runner returns it; docs/work/runner.md has the detail). reviewer-2 read it: it only enables the feature, grants nobody access, and cannot be undone on ext4.
- Opt-in only: it is offered when the person turns on lending their computer, never by default, never at install. Before doing it the installer or the Deck says one plain line: "This turns on file encryption for this server's disk. It cannot be undone, and it changes nothing else." Nothing happens without that answer.
- A closed verb of the same helper: `fscrypt-enable` with no argument. The device is NEVER in the request: root looks up the filesystem under the lending base folder itself (`findmnt -no FSTYPE,SOURCE --target <root's own configured base>`), and acts only when the type is ext4 and the source is a block device under /dev; btrfs, xfs, zfs, a network disk or a missing answer is a refusal that says runner falls back to the slower method by itself. The command is exactly `tune2fs -O encrypt <that device>`, nothing else, no other flags, and it is skipped (success, nothing run) when `tune2fs -l` already lists the feature.
- It carries the same framing as every verb: a request id, a status by id, the log line with the device, and the presence requirement of a destructive-class verb (reviewer-2 B-4: the daemon's uid proves only that it asked), because it is irreversible.

## Revision 2 (6 Oct, after reviewer-2's second pass): RH-1, RH-2, RH-3. This section replaces anything above that disagrees.

The spool grammar is exactly: `^(up|stop|down|firewall-add|firewall-del) <name>$`. Five verbs. `purge` and `fscrypt-enable` are not in it and the helper never reads them from a spool.

A sixth verb, `publish-fill <space id> <site folder> <deployment>`, has its own anchored pattern `^publish-fill spc_[a-z0-9]{12} site-[A-Za-z0-9]{6} [0-9a-f]{16}$` and takes no Space name: it copies a published static site's files into the site's volume (see the CHANGELOG). The volume name `vyre-publish-<space id>_site-<deployment>` and the folder under the daemon's home are rebuilt by the helper, which claims the folder by rename, checks it as root, copies it in a throwaway container with no network, checks the volume and puts the folder back.

### RH-1 Who makes each secret, where it lives, who can read it

| Secret | Made by | When | Lives | Readable by |
|---|---|---|---|---|
| Postgres password | root (the helper) | first `up` of the Space | `<root folder>/spaces/<name>/secrets` (0600, root) | root only |
| Twenty application secrets (`APP_SECRET`, token secrets) | root | first `up` | same file | root only |
| The Space's workspace API key and the admin account behind it | the daemon | after the first `up` answers `ok` | the daemon's own vault, as today | the daemon (and the vault's grants) |

- Root generates the first two with `openssl rand`, writes them once (0600, parents checked as `unit_dirs_ok` does), and never changes them; a later `up` reuses the file. The regenerated compose takes them from that root-only file as `environment` values root writes into its OWN copy of the compose. The compose has no `env_file` and no path under the daemon's home; the linter refuses any `env_file` key.
- The daemon never reads the database password or the application secrets. What a compromised daemon can read of the store is therefore its own workspace key (the API), not the database or the signing secrets, which is the point of the split.
- The workspace key comes from Twenty's own first-user bootstrap: after `up` is `ok`, the daemon signs up the first user with a random password it generates (kept in its vault), creates its API key through Twenty's API, and stores that key. No bootstrap file, no secret in a request, nothing for root to hand over, nothing to remove afterwards.
- No secret travels in a request (the grammar has no argument beyond the name) and none appears in the status or the log (H-4 stands: no path, no digest, no environment).
- The helper's secrets file is part of root's per-Space record. `down` leaves it (the volume is kept with it, so a restart finds the same database password); the host-CLI `purge` below removes both together.

### RH-2 `purge` is out of the helper; `fscrypt-enable` is host CLI only

- `purge` is not a spool verb in 0.3. The only way to destroy a Space's store is the host CLI path below, so a compromised daemon cannot ask for it and a deleted Space in the Deck leaves the volumes in place until the owner purges at the server.
- `fscrypt-enable` is not a spool verb either: host CLI only, with a typed confirmation. The Deck can show the plain line and the command to run; it cannot run it.
- ONE host-CLI path for every destructive or irreversible action (agreed with tailnet for "reset with wipe" and vault for its own; to be confirmed by their replies): `sudo vyre admin <action> [target]`. It is the box wrapper's own root path (not the spool, not the daemon, not a socket). It requires a terminal on stdin and stdout (a pipe is refused), prints the plain one-line consequence, and proceeds only when the person types the exact word shown (`purge harlow`, or `fscrypt`), not `y`. Actions are a closed list in the wrapper: `purge <space>` (compose `down -v` on root's own copy, then removes the Space's record and secrets), `fscrypt-enable`, and the ones tailnet and vault name. Each is logged once, with who ran it (SUDO_USER) and the action, to the helper's log.
- The `purge` action refuses while any container of the project runs unless the typed word carries `--stop` first, so it stops the project itself, then destroys.

### RH-3 The firewall probe, and what a recreated container does

- The pid comes from `docker inspect -f '{{.State.Pid}}' <name>` on the exact container name the box's compose gives the vyre service (`vyre-vyre-1`), never from the request or any file the daemon can write. A pid of 0, or a container not running, fails the request.
- Apply: `nsenter -t <pid> -n iptables ...` (and ip6tables when the container has IPv6), `-C` first, `-I OUTPUT 1`, the comment `vyre:<name>`, `--uid-owner 2000-2063`, destination the store subnet.
- The probe runs in that container's own namespace as uid 2000: `nsenter -t <pid> -n setpriv --reuid=2000 --regid=2000 --clear-groups -- <probe>`, where the probe is a TCP connect to the store's address and port from a fixed helper script root owns (a `bash /dev/tcp` or `nc -z -w2` with absolute paths). The rule passes only when the connect is REFUSED (an immediate reject, not a timeout, so a dropped probe is not mistaken for a block); a connect that succeeds, or a timeout, fails the request. A second probe runs as uid 1000 (the daemon) and must SUCCEED, so the rule cannot pass by blocking everything.
- The rule lives in the container's network namespace and is gone when the container is recreated (an update, a `compose up` with a changed config). So the rule is checked, never assumed: every `up` runs the apply and the probe again, and an `up` for a Space whose rule is missing or whose probe passes the connect FAILS before the store is started (the Space is never started unfirewalled). The helper also re-checks at its own start for every Space in root's record and reports a Space without its rule as `failed: firewall missing` in that Space's status; the box wrapper's `update` runs `firewall-add` for each recorded Space after the new container is up, and its `ready` waits for that.
- Test on a real box: connect as uid 2000 and get refused, as uid 1000 and get through; recreate the vyre container and see the next `up` fail with no rule and pass after `firewall-add`; apply twice leaves one rule; a failed probe makes `up` fail.

Code starts when reviewer-3 confirms the firewall side (RH-3 and open point 2).

## Built (6 Oct, work/launch-03)

Code lives in the box wrapper (box/vyre, the "Space helper" block), so the release build strips its test seams with the rest (scripts/strip-wrapper.mjs). `vyre space-helper install` records the image id the vyre container runs and the image names the generator may use, writes `vyre-spaces.path` (DirectoryNotEmpty on the spool, trigger limits off) and the oneshot service, and the installer runs it once the container is up (scripts/install-box.sh). The compose mounts `<root>/spool` (read-write) and `<root>/status` (read-only) into the daemon's container.
- `up` order: secrets (root-only, once) -> regenerate and lint the compose in the recorded image -> `compose create` -> the vyre container joins `vyre-<name>-twenty_store` with alias `vyre-<name>` -> the rule goes into its namespace (fresh pid, `-C` then `-I OUTPUT 1`, verified) -> `compose up -d --wait` -> the probe (agent uid 2000 refused at once, control uid 1000 reaches the store, each address family) -> a failed probe stops the store and fails the request. The store never starts before the rule is in.
- `down` leaves the data, the secrets and the rule; `firewall-del` removes exactly the rules carrying `vyre:<name>`, only while no container of the project runs.
- After every healthy `vyre update` the wrapper re-records the image and runs `space_helper_reattach` (also `sudo vyre space-helper reattach`): each recorded Space that still runs is joined and firewalled again and proved; one that cannot be proved is stopped.
- `sudo vyre admin purge <space>` and `sudo vyre admin fscrypt-enable` are the only destructive paths: a terminal, the plain consequence, an exact typed word. Neither is a spool verb.
- Limits, said plainly: images are pulled and recorded BY DIGEST at install and at every update (a pull of the tag at that moment: nothing signs Twenty's, Postgres's or Redis's images yet, so the digest is as trustworthy as the registry at that moment and fixed from then on); the bind mount `./empty-front` is the one bind, an empty folder root makes in its own copy; a request from another uid is only proved on a real box. The fscrypt target is found by root from Docker's mounts of the vyre container (the host folder behind `/home/vyre/.vyre`), never from a file the daemon can write.
- SH-1 (reviewer-3, ship gate): `core/spawner/space-wall.sh`, run by `wall-entry.sh` as root with NET_ADMIN on every start of the vyre container and before the daemon, puts in the rule for every subnet in `status/subnets` (the helper keeps that file: one `<space> <subnet>` line per firewalled store). A rule that cannot be put in stops the container. The helper's re-apply on `up`/update and its start-event watcher stay as the second and third layers. SH-2: addresses Docker prints as `invalid IP` are ignored. SH-3: `firewall-del` reads the comment quoted or bare, strips the quotes before `-D`, and reports success only after a second listing shows no line naming the Space.

## The saved database (5 Oct 2026)

A NEW Space starts from a saved, already migrated Twenty database when the vyre image carries one (`stores/twenty/golden/<tag>.dump`, built in CI by `.github/actions/twenty-golden`, about 1 MB): a working Space in about a minute, not thirteen. Slow path unchanged when there is none.

- `sp_golden` (new Space only, in `sp_up`): root asks the image for the dump's path (the generator's own `findGolden`, run the same way as `sp_run_gen`: no network, read-only, unprivileged), takes it out with `docker create` and `docker cp` (never a mount) once per image id into `private/golden/golden.dump` (0444, one copy for every Space), and makes the Space's admin password. The password goes into the Space's `secrets.env` (`ADMIN_PASSWORD`, with `GOLDEN_DUMP`) and into `status/admin-<name>` (0600, the daemon's uid; root removes it after ten minutes). No request carries it, and any failure is the slow path.
- `sp_gen` passes the generator `golden` (the first start) or `migrated` (every later one). `golden` adds a one-shot `restore` service that loads the dump into the empty database, deletes the saved signing key, and sets the Space's own password on the saved user (read by psql from its environment, never on a command line); the server then skips its migration steps (`DISABLE_DB_MIGRATIONS`). `migrated` keeps only that flag. After the first healthy `up` root moves the marker `golden` to `migrated` and regenerates, so the restore step is gone.
- `sp_lint` allows the one extra service (`restore`), the `entrypoint` key and exactly one new mount, `${GOLDEN_DUMP:-./golden.dump}:/golden.dump:ro`. Still no published port, still an internal network, still only the images root recorded.
- The daemon side (`stores/twenty/helper.js` `adminPassword`, `stores/twenty/provision.js`): after `up` it reads the password root left, signs in as the saved user once, and makes the Space's own API key. No file means root did not use the saved database, and the Space is made the plain way.


## Swap on a small server (windows, 5 Oct; ruling: encrypted or none)
A Linux server under 6 GB of memory with no swap gets ENCRYPTED swap, or none. A server holds lent keys and session leases in memory, and swap writes memory to disk, so plain swap is never used. `sp_swap` makes one 2 GB backing file at /var/lib/vyre-swapfile (root-only, mode 600; an existing file is used only if it is a regular file of the running user with mode 600), attaches it to a loop device, and opens a dm-crypt PLAIN mapping on it keyed from /dev/urandom (aes-xts-plain64, 512-bit key, never stored), then mkswap and swapon on the mapping. /etc/crypttab gets `vyre-swap <file> /dev/urandom swap,cipher=aes-xts-plain64,size=512` and /etc/fstab the mapping, so every boot makes a new random key and nothing survives a reboot. With no cryptsetup or no losetup there is NO swap and no file (the capped run held without it); a failed step is undone and only logs. Tested both ways with fakes (test/space-helper-swap.test.js); not run on a real host.
