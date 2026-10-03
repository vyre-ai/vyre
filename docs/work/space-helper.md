# Space helper (launch, 4 Oct): the root side of a Space's Twenty store

Needs: docs/work/records.md on work/records, "Root helper for a real box". Gate: reviewer-3, because this runs as root. Status: DESIGN for review; no code yet.

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
5. Firewall: exactly the three rules records' `firewallRules()` defines, in OUTPUT and DOCKER-USER only, each with the comment `vyre:<name>`. The subnet comes from `docker network inspect vyre-<name>-twenty_store`, never from the request. The agent uid range is the installer's (2000 to 2063). Each rule is checked with `-C` before `-A`, so applying twice changes nothing; `firewall-del` removes exactly the rules carrying `vyre:<name>`. No other table, chain, target or flag.
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
