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

### Config (`~/.vyre/config.json`)

```json
{ "computers": { "docker": "http://docker-proxy:2375", "image": "vyre/computer:0.1", "network": "vyre-computers",
  "labelPrefix": "vyre", "screens": 2, "idleMs": 60000, "freezeMs": 15000, "cpus": 2, "memoryMb": 3072 } }
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
| `computers.may-act` (internal) | `{agent, tool}` | `{ok: true}` or `{ok: false, why, holder?}`; touches the checkout |

`surface` names a person's screen: `glass:<device>`, `deck:<device>`, `phone:<device>`.
An agent's own hands resolve the agent from the caller `mcp:agent:<name>`; a non-assistant agent
can only act on its own computer. The assistant, the CLI and the Deck pass `agent` explicitly.

### Events

`computer.created`, `computer.checked-out {agent, thread, screen}`, `computer.released {agent, why}`,
`computer.frozen`, `computer.thawed`, `computer.stopped`, `computer.paused`, `computer.resumed`,
`computer.taken-over {agent, surface, thread}`, `computer.handed-back {agent, surface, why}`.
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
  `docs/adr/0004-container-hardening.md`): the restricted proxy only filters endpoints, not
  request bodies, so Privileged, host devices, host network/PID and extra capabilities are never
  read from anywhere, `CapDrop` is always `ALL`, the root filesystem is read-only with tmpfs for
  the paths `entrypoint.sh` actually writes, and every container and volume carries a fixed
  `run.vyre=1` label alongside the existing `labelPrefix` pair. Tested that a create body never
  carries any of the dangerous fields, including a scan for a `docker.sock` bind. Not yet proven
  against a real Engine — the read-only-root/tmpfs split is the first thing to check once a
  container actually boots on the box.
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

## Doing
- Glass review (from the `glass` workstream) found real gaps to fix on this side: backpressure on
  the Xvnc→browser relay, a server-side keepalive replacing the "renew every 30s" take-over
  contract, RFB close codes, always dropping `SetDesktopSize`/`xvp` regardless of what the client
  asked for, a per-computer viewer cap, and `entrypoint.sh` hardening (clipboard/cut-text off,
  stale Chrome singleton locks, password manager off). Also building `computers.shield {agent, on}`
  and `computers.helper {agent}` as new internal tools for glass's sign-in mode. Not started yet
  this pass — next up.

## Next
- The glass review fixes above.
- Real container runs on the box: the stack is up (`/srv/vyre`, compose project `vyre`, label
  prefix `run.vyre.computers`) and a restricted Docker proxy is reachable at
  `tcp://docker-api:2375` over an internal network only vyred can reach (per box, 26 Sep). Next
  concrete step: ask box how to point this worktree's tooling at it and run one real container —
  first real validation of the Dockerfile, entrypoint.sh, computerd and the hardening above.

## Needs from others
- security: `computers.takeover`/`computers.giveback` only check the *named* surface matches the
  take-over record, never that the caller *is* that surface — an agent (or anything else) can pass
  any surface string and end a person's take-over mid-action. Asked security to gate both behind
  whatever HUMAN_ONLY / caller-identity enforcement already exists (asked 26 Sep, unanswered).
- box: label prefix confirmation — docker.js now sends a fixed `run.vyre: "1"` label on top of the
  existing `labelPrefix`-based pair, and expects the box's compose config to set
  `computers.labelPrefix` to `run.vyre.computers` so the prefix-based labels read
  `run.vyre.computers.computer=<agent>`; flagged for box to confirm that reading is right.
- gate: the container's egress. Until the Gate exists the network is internal plus whatever the box
  allows; consequential clicks (send, pay, delete) are refused by the hands, not held.

## Changed contracts
- `ctx.upgrade(name, handler)` in `core/modules` and the WebSocket upgrade path
  `/v1/streams/<module>/...` in `core/daemon`: landed on main before this resumed. Glass is its
  first real consumer.
- `threads.lease`/`threads.release`/`lease.changed`/`agents.list`/`agents.threads`: confirmed
  against the real, merged switchboard and agents modules (26 Sep) — `keyboard.js` needed no
  changes, only the tests did.
