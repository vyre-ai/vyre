# ADR 0009 · Hardening an agent's container

Status: accepted, 26 Sep 2026 · Workstream: computers · Spec: section 7.9

## The problem

An agent's computer is a container, made and driven by `core/computers/driver/docker.js` through
box's restricted Docker API proxy (`tecnativa/docker-socket-proxy`, `docs/work/computers.md`'s
`computers.docker`). The proxy's job is to keep vyred off the raw Docker socket, which is
root-equivalent on the box: it allow-lists which Engine *endpoints* are reachable (containers,
images, exec, a POST, info) and denies others outright (networks, volumes).

What it does not do is read request *bodies*. A `POST /containers/create` the proxy lets through
can still ask for `Privileged: true`, a bind mount of `/var/run/docker.sock`, `NetworkMode: host`,
`PidMode: host`, extra Linux capabilities, or host devices — and the proxy has no opinion on any
of them, because none of that is which endpoint was called. Anything that can reach vyred's
`computers.checkout` (an agent, a bug, a bad label) can therefore ask docker.js to build a body
like that, and if docker.js ever did, the proxy would carry it straight to the Engine. A
container created that way is not sandboxed at all: it is root on the host.

So the boundary has to be in the one place that builds every create body: `DockerDriver.create()`.

## Decision

`create()` never reads a dangerous flag from anywhere — not `CreateSpec`, not config, not a
caller — because `CreateSpec` (`core/computers/driver/index.js`) has no field for any of them and
never will. Every one of the following is hard-coded, not merely defaulted:

- **`Privileged: false`**, always. There is no parameter that can set it true.
- **No bind mounts.** The only entry in `Mounts` is the agent's own named volume at
  `/home/agent`; nothing else is ever mounted, so `/var/run/docker.sock` can never appear in a
  create body. A test asserts this by scanning the whole body for the string, not just the one
  field, since a mistake could as easily land it somewhere else.
- **Never the host network or PID namespace.** `create()` throws before building a body if the
  resolved network is `"host"`, from either the spec or the driver's own config default —
  defense in depth, since nothing in this codebase passes that today. `PidMode: "container"` is
  set explicitly rather than left to the Engine's default, so an agent's computer never sees the
  box's own process table.
- **`CapDrop: ["ALL"]`**, unconditionally. Xvnc, Chrome (already `--no-sandbox`, since the
  container has no setuid sandbox helper), AT-SPI and xdotool all run as the unprivileged
  `agent` user and need no Linux capability. `computers.capAdd` still exists for a box that
  finds otherwise, so this file never grows a capability list of its own.
- **`Devices: []`**, always. An agent's computer has no reason to see anything under the box's
  `/dev`.
- **`ReadonlyRootfs: true`**, with a small `Tmpfs` for `/tmp`, `/run` and `/var/run` — where
  Xvnc's X11 socket and lock live, and where `dbus-launch` puts the session bus AT-SPI needs.
  Everything that has to persist (the Chrome profile, `.vnc`, `.fluxbox`, the entrypoint's own
  log files) already lives under `/home/agent`, which is the one volume mount and is writable
  regardless of the root filesystem's mode.
- **No custom seccomp profile.** `SecurityOpt` carries `no-new-privileges` and nothing that
  names `seccomp=`, so the Engine applies its own default profile, which already denies the
  syscalls that matter here (`mount`, `ptrace` outside the container, the kernel keyring, and
  more). A hand-written profile was considered and set aside: without a real container to test
  it against, a mistake in a custom profile is more likely to silently break Xvnc, xdotool or
  AT-SPI than to buy meaningfully more safety over the default.
- **Labels.** Every container and its volume carry a fixed `run.vyre: "1"`, independent of
  whatever `computers.labelPrefix` is configured to, plus the existing
  `<prefix>.managed=true` / `<prefix>.computer=<agent>` pair this file already used to decide
  which containers are its own (see `docker.js`'s header comment). Box's compose stack expects
  `computers.labelPrefix` set to `run.vyre.computers` at deploy time, which this ADR does not
  change the code default of (`"vyre"`, used by every existing test) — that is a config value on
  the box, not a hard-coded one here.

## Consequences

- `docker.test.js` proves each of the above against a fake Engine: no `Privileged`, no bind
  mount, no `docker.sock` string anywhere in a create body, `NetworkMode`/`PidMode` never
  `"host"` (and `create()` throwing if asked), `CapDrop: ["ALL"]` and `Devices: []` always
  present, `ReadonlyRootfs: true` with a non-empty `Tmpfs`, and both label sets on every
  container and volume.
- A read-only root is untested against a real container (there is no Linux Docker host in this
  worktree yet). The `Tmpfs` set is a read of `entrypoint.sh`'s own writes, not a run of it;
  the box's first real container is also the first real check of whether that list is complete.
- `computers.capAdd` remains the one escape hatch, and stays config, not code: a box that finds
  a capability genuinely needed adds exactly that one, never a default list.
- **Known gap (security, 26 Sep):** none of the above holds against a caller that reaches the
  restricted proxy directly instead of through `DockerDriver.create()` — a Claude session's own
  Bash shares vyred's container and network namespace, so a raw `curl` to `docker-api:2375` can
  ask for `Privileged: true` and a host bind mount, and the proxy (which filters endpoints, not
  bodies) forwards it: root on the host. A text filter in the harness floor denies the obvious
  strings (`docker-api`, `:2375`, `:2376`) but is not the real fix. The real fix is a
  body-checking proxy vyred itself owns in front of the Engine (accepting only exactly the shape
  this file builds), or moving Claude's own sessions off the `docker-api` network entirely —
  open, and bigger than this file, since it needs box and security too.
