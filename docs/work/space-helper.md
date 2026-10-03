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
