# computers

Branch: work/computers · Worktree: ../vyre-computers · Milestone: M8 · Wave 2 (after switchboard merges)

## Scope

Owns `core/computers/`, `modules/hands-desktop/`, `modules/hands-chrome/`, and the Glass views
in `deck/glass/` (agree the folder with the deck session first).

Each agent gets its own computer: a container with a desktop, Chrome and a terminal. Screens come
from a shared pool and are checked out only while an agent needs to look; idle containers freeze.
Glass streams a screen to the Deck, with take-over (one keyboard at a time, via the switchboard lease).

- Containers with Docker on Linux (the box). Image: Xvfb or a Wayland compositor, a VNC or WebRTC
  stream, Chrome with remote debugging, a terminal.
- `hands-chrome`: Chrome control over CDP from one long-lived connection (port the measured
  design in `the prototype's bin/macd.cjs`: a persistent daemon was 137x faster than per-call spawns).
- `hands-desktop`: the accessibility tree over AT-SPI (`the prototype's bin/desktop.cjs`), with
  verified actions (`act.cjs`, `verify.cjs`, `selector.cjs`).

## Done when

An agent thread opens a page in its own container's Chrome, the user watches it live in Glass
on the Deck, takes over, types, and hands back.

## Design

Stream and take-over: [ADR 0003](../adr/0003-glass-stream.md) (RFB over a WebSocket, relayed and
gated by vyred).

```
core/computers/            module "computers", role box
  index.js                 tools, events, wiring
  pool.js                  computers, the screen pool, idle freeze
  keyboard.js              take-over on top of threads.lease
  driver/docker.js         Docker Engine API through the restricted proxy (never the raw socket)
  driver/fake.js           in-memory driver for tests (and a local mode that points at the Mac's Chrome)
  glass.js                 the RFB relay and input gate behind /v1/streams/computers/glass
  image/                   the agent computer: Dockerfile, entrypoint, computerd (the in-container helper)
modules/hands-chrome/      Chrome over one CDP connection per computer
modules/hands-desktop/     AT-SPI tree and verified actions through computerd
deck/glass/                Glass views (watch, take-over, phone), vendored noVNC
```

### The pool

- One container per agent with `computer: true`, created on first need, with its own home volume.
  Container states: `none`, `running`, `frozen` (docker pause), `stopped`.
- Screens are a shared pool of `computers.screens` slots (default 2). A checkout is
  `{agent, thread, since, touched}`. An agent's hands check out on their first action and touch on
  every one; an open Glass viewer or a take-over also holds it. A checkout untouched for
  `computers.idleMs` (default 60 s) with no viewer and no take-over is released.
- A released computer is frozen after `computers.freezeMs` (default 15 s). A checkout thaws it.
- A full pool evicts the least recently touched checkout with no viewer and no take-over; if every
  slot is watched or taken over, the checkout waits (up to 30 s) and then fails with who holds the
  screens.
- `freeze()` only ever looks at idle checkouts, so an actively-held one whose container vanishes
  behind vyred's back (an operator, the box) would otherwise go unnoticed indefinitely. Every
  `verifyMs`, `checkout()`'s "already held" path asks the driver once whether the container still
  exists; gone releases it, so the next `checkout()` rebuilds it rather than trusting a screen
  nobody can reach. Found on the box's first real run.

### Config (`~/.vyre/config.json`)

```json
{ "computers": { "docker": "http://docker-proxy:2375", "image": "vyre/computer:0.1", "network": "vyre-computers",
  "labelPrefix": "vyre", "screens": 2, "idleMs": 60000, "freezeMs": 15000, "verifyMs": 30000, "cpus": 2, "memoryMb": 3072 } }
```

The driver only touches containers carrying the label `<labelPrefix>.computer=<agent>`, whatever
the proxy allows. Without `computers.docker` the module starts with the fake driver off and says so
in `computers.list` (`driver: "none"`).

## Contracts

### Tools (module `computers`)

| Tool | Input | Returns |
|---|---|---|
| `computers.list` | `{}` | `[{agent, state, screen, thread, viewers, takeover, paused, size, since}]` |
| `computers.get` | `{agent}` | one of the above |
| `computers.checkout` | `{agent, thread?, why?}` | `{agent, screen, thread}` |
| `computers.release` | `{agent}` | `{released}` |
| `computers.stop` | `{agent}` | `{stopped}` (the container stops; its home volume stays) |
| `computers.pause` / `computers.resume` | `{agent}` | `{paused}` (the agent's hands refuse input; Pause kit on the board) |
| `computers.takeover` | `{agent, surface}` | `{agent, surface, thread, previous}` |
| `computers.giveback` | `{agent, surface}` | `{agent, handed_back}` |
| `computers.watch` | `{agent, surface}` | `{ticket, path: "/v1/streams/computers/glass?ticket=...", width, height}` |
| `computers.endpoint` (internal) | `{agent}` | `{helper: {url, token}}`; checks out, thaws. Chrome is reached only through `helper`'s own `/cdp` proxy (ADR 0005), never a raw address |
| `computers.may-act` (internal) | `{agent, tool}` | `{ok: true}` or `{ok: false, why, holder?, shielded?}`; touches the checkout |
| `computers.helper` (internal) | `{agent}` | `{url, token}`; thaws a frozen computer but takes no screen — for a sign-in or a file browse that only needs computerd |
| `computers.shield` | `{agent, on}` | `{agent, shielded}`; while on, `may-act` refuses every read and action regardless of pause/take-over, and computerd is best-effort told to 423 its own routes too (defense in depth, not the source of truth) |

`surface` names a person's screen: `glass:<device>`, `deck:<device>`, `phone:<device>`, `capsule:<device>`.
An agent's own hands resolve the agent from the caller `mcp:agent:<name>`; a non-assistant agent
can only act on its own computer. The assistant, the CLI and the Deck pass `agent` explicitly.

### Events

`computer.created`, `computer.checked-out {agent, thread, screen}`, `computer.released {agent, why}`,
`computer.frozen`, `computer.thawed`, `computer.stopped`, `computer.paused`, `computer.resumed`,
`computer.taken-over {agent, surface, thread}`, `computer.handed-back {agent, surface, why}`,
`computer.shielded {agent}`, `computer.unshielded {agent}`.
`chrome.acted` and `desktop.acted` `{agent, action, summary, ok, why?}` feed Glass's action log.
No payload ever carries the VNC password, the helper token or page content beyond a short summary.

### computerd (inside the container, port 7000, `Authorization: Bearer <token>`)

| Route | Does |
|---|---|
| `GET /health` | `{ok, display, size: {w, h}, chrome}` |
| `GET /apps` | `[{name, pid, windows: [title]}]` from AT-SPI |
| `GET /tree?app=<name>` | `{window, nodes: [{path, role, name, description, enabled, focused, value, x, y, w, h, container}]}` (the raw shape `desktop.cjs` reads); `app` omitted means the focused app |
| `POST /act` | `{path, action: "press"|"focus"|"set-text", value?}` through AT-SPI actions |
| `POST /input` | `{kind: "click", x, y, button?}`, `{kind: "key", keys: "ctrl+l"}`, `{kind: "type", text}` through xdotool |
| `GET /screenshot` | `image/png` of the whole display |
| `GET /cdp/json/version` | Chrome's own answer, `webSocketDebuggerUrl` rewritten to `ws://<host>/cdp/...` |
| WS upgrade `/cdp/...` | an authenticated raw pipe to Chrome's loopback debugging port (token in `?token=`, a plain WebSocket cannot send a header; ADR 0005) |
| `POST /shield` | `{on}`; while on, `/tree`, `/screenshot`, `/act` and `/input` answer 423 instead of doing anything. Set by `computers.shield`, best-effort — vyred's own `may-act` refusal is the real gate, this is defense in depth in case anything reaches computerd directly |

Ports inside the container: `5900` Xvnc (VNC auth, password from `VNC_PASSWORD`), `7000`
computerd (`COMPUTERD_TOKEN`). None is published on the host; vyred reaches them over the internal
network. Chrome's own debugging port (9222) is not one of them: it is loopback-only, reached only
by computerd's `/cdp` routes above (ADR 0005; an earlier version relayed it out on its own
unauthenticated port, which was a real hole).

## Done
- ADR 0003 and this design.
- The pool, idle freeze, take-over on the thread lease (`core/computers/pool.js`, `keyboard.js`),
  the Docker and fake drivers, wired into `index.js`'s tools. Tested against a fake driver.
- `hands-chrome` and `hands-desktop`: full modules (act, snapshot, selector, verify, consequence,
  a CDP/computerd client each), with their own tests. `hands-chrome`'s Chrome-backed tests ran
  for real against headless Chromium on this Mac (a temp profile, per the lead's instruction) and
  pass; `hands-desktop`'s tests run against a fake computerd, since there is no AT-SPI on macOS.
- Glass (`core/computers/glass.js`, `ws.js`, and the predecessor's `rfb.js`): the RFB relay behind
  `/v1/streams/computers/glass`, using the `ctx.upgrade` path that had landed on main by the time
  this resumed. `ws.js` hand-rolls the RFC 6455 handshake and framing (no `ws` dependency in this
  repo); `glass.js` redeems the ticket before completing the WebSocket handshake, relays
  Xvnc-to-browser bytes untouched, and gates browser-to-Xvnc input through `keyboard.canType`.
  Tested end to end against a fake RFB server and a real TCP/WebSocket-framed client; no real
  Xvnc reached yet (needs a container).
- The container image (`core/computers/image/`: Dockerfile, entrypoint.sh, computerd in Node +
  Python/AT-SPI). Built by inspection against ADR 0003's port table and the design doc's
  computerd route table; never `docker build`'d, since there is no Linux Docker host in this
  worktree.

- The docker driver is hardened against a privileged or host-mounted container (`driver/docker.js`,
  `docs/adr/0009-container-hardening.md`): the restricted proxy only filters endpoints, not
  request bodies, so Privileged, host devices, host network/PID and extra capabilities are never
  read from anywhere, `CapDrop` is always `ALL`, the root filesystem is read-only with tmpfs for
  the paths `entrypoint.sh` actually writes, and every container and volume carries a fixed
  `run.vyre=1` label alongside the existing `labelPrefix` pair. Tested that a create body never
  carries any of the dangerous fields, including a scan for a `docker.sock` bind. Proven against
  the real Engine on the box (see the real container run below): the read-only-root/tmpfs split
  boots and runs Xvnc, Chrome and computerd correctly under it.
- Rebuilt `computers.test.js`, `hands-chrome`'s and `hands-desktop`'s tests on the real
  `core/agents` and `core/switchboard` modules that landed on `main`: the module loader's
  first-found-wins rule means a same-named test fake is now silently ignored, so the old
  `writeModule("agents", ...)` / `writeModule("threads", ...)` stand-ins were dead weight after
  the merge. Tests call the real `agents.create`; the take-over tests that exercise
  `threads.lease` launch a real thread through switchboard's `testing/fake-claude.js`, per the
  pattern in `core/switchboard/switchboard.test.js`. Also fixed a real (non-test) bug found along
  the way: `agents.list`'s shaped rows dropped the `computer` field, so `pool.js`'s `allowed()`
  refused every real agent regardless of its record — one line in `core/agents/index.js`, outside
  this workstream's folders, flagged to switchboard.

- Chrome's debugging port is no longer reachable off `127.0.0.1` inside the container at all:
  `computerd` proxies CDP discovery and the WebSocket session itself, authenticated the same as
  every other route (`docs/adr/0012-cdp-proxy.md`). The old `socat` relay to a published `9223`
  is gone.
- `computers.helper`, `computers.shield`, and computerd's `/fs` routes: built by the `glass`
  workstream (`core/computers/helper.js`, `shield.js`, `image/computerd/fs.js`) for their sign-in
  mode and file browser. An earlier pass here built a duplicate, in-memory version of the same
  two tools directly in `pool.js`/`keyboard.js` before noticing glass had already shipped theirs
  on `main` — that duplicate is deleted; glass's is the one and only implementation now. `surface`
  also accepts `capsule:<device>`.
- An ordinary agent cannot claim to be a person's surface: `computers.takeover`, `.giveback` and
  `.watch` refuse a caller identified as an agent (the assistant stays exempt), closing the
  specific hole glass found — an agent ending a person's take-over mid-action by naming their
  surface. Still not the full guard: a trusted channel (cli, local, a module, the assistant) can
  still claim a surface it is not actually connected as; that needs the Rules layer's
  caller-identity check (asked of security 26 Sep, still open).
- **The real container run, on the box, end to end** — the first genuine proof the image design
  works, not just passes review by inspection. Two real bugs turned up on the very first Engine
  calls, both fixed (`ea3c2a0`, `f98d1fa`):
  - `HostConfig.PidMode: "container"` is not a valid value on its own (Docker wants `""`, `"host"`
    or `"container:<id>"`, and there is no other container to share a namespace with) — the
    Engine refused the create outright. Fixed by omitting the field; the isolated default was
    always what was meant.
  - Debian bookworm's `tigervnc-standalone-server`/`tigervnc-common` ship `Xvnc` (via
    `update-alternatives`) but no standalone `vncpasswd` binary at all, so the container died on
    its first line of `entrypoint.sh`. `image/computerd/vncpasswd.mjs` writes the password file
    itself (the standard fixed-key single-DES obfuscation), reading `VNC_PASSWORD` from the
    environment so it never reaches `ps`.
  - With both fixed, one real container ran the full stack and was proven live: `computerd`'s
    `/health` answered over its bearer token and refused a wrong one; `/cdp/json/version`
    correctly rewrote `webSocketDebuggerUrl` to point back through itself; and — the strongest
    check — a real RFB client handshake, run from `rfb.js` itself against the container's real
    Xvnc with the real password file, completed a real VNC authentication and reported the right
    screen size back. Cleaned up afterward (`computers.stop`, then `docker rm` the container and
    its home volume).
  - `image/Dockerfile` was first fixed here with a hand-rolled `computerd/vncpasswd.mjs` (no
    `vncpasswd` binary at all on bookworm's tigervnc packages) — superseded by `glass`'s own live
    run finding the same two bugs and fixing them better: `tigervnc-tools` actually has the real
    binary, just under a different package than expected. Reconciled onto glass's fix; the
    hand-rolled script is gone.
  - `computers.checkout`'s "already held" fast path never re-verified the container was still
    alive, since `freeze()` only ever looks at idle checkouts — found here by hand, mid debugging,
    when removing a container out from under vyred left `computers.get` reporting `running`
    indefinitely. Fixed: see `verifyMs` above.
  - `core/agents` has no delete tool at all, so a test agent made for a probe like this can only
    be neutralized (`computer: false`), never removed. Flagged to switchboard, not fixed here.

## Doing
- Nothing in parallel right now.

## Next
- Glass's ADR 0005 review list, decision 1 (still mine, not yet started): backpressure on the
  Xvnc→browser relay, a server-side keepalive replacing the "renew every 30s" take-over contract,
  RFB close codes, always dropping `SetDesktopSize`/`xvp` regardless of what the client asked for,
  a per-computer viewer cap of 4, and `entrypoint.sh` hardening (clipboard/cut-text off, stale
  Chrome singleton locks, password manager off).
- The xterm font warning seen in the real container's logs (`cannot load font
  "-misc-fixed-medium-r-semicondensed--13-120-75-75-c-60-iso10646-1"`) and the `_XSERVTransmkdir`
  warning about `/tmp/.X11-unix` under the non-root user — neither stopped the container from
  working, but both are worth a look before this ships for real use.

## Needs from others
- security: still open (asked 26 Sep) — the Rules-layer caller-identity check described above.
- gate: the container's egress. Until the Gate exists the network is internal plus whatever the box
  allows; consequential clicks (send, pay, delete) are refused by the hands, not held.

## Changed contracts
- `ctx.upgrade(name, handler)` in `core/modules` and the WebSocket upgrade path
  `/v1/streams/<module>/...` in `core/daemon`: landed on main before this resumed. Glass is its
  first real consumer.
- `threads.lease`/`threads.release`/`lease.changed`/`agents.list`/`agents.threads`: confirmed
  against the real, merged switchboard and agents modules (26 Sep) — `keyboard.js` needed no
  changes, only the tests did.
