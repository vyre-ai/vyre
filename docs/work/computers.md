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
| `computers.endpoint` (internal) | `{agent}` | `{cdp: "http://host:port", helper: {url, token}}`; checks out, thaws |
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

Ports inside the container: `5900` Xvnc (VNC auth, password from `VNC_PASSWORD`), `9223` Chrome's
debugging port relayed from `127.0.0.1:9222`, `7000` computerd (`COMPUTERD_TOKEN`). None is
published on the host; vyred reaches them over the internal network.

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

## Doing
- Nothing in parallel right now; waiting on switchboard, deck and the box (below).

## Next
- Once switchboard confirms the lease shapes: point `keyboard.js`'s tests at the real
  `threads.lease` contract instead of the stub, if it differs.
- Once deck confirms the `deck/glass/` path: the watch/take-over/phone views (vendoring noVNC,
  or writing straight against `ws.js`'s framing and `computers.watch`'s ticket, whichever deck
  prefers).
- Real container runs on the box once the lead says it is ready and names the label prefix. That
  first run is also the first real validation of the Dockerfile, entrypoint.sh and computerd:
  expect to find things (AT-SPI's session bus timing, Xvnc's `-SecurityTypes` flag name, whether
  `chromium --remote-debugging-address=127.0.0.1` actually stays loopback-only under whatever the
  box's network policy is) that inspection alone could not catch.

## Needs from others
- switchboard: confirm `threads.lease` / `threads.release` / `lease.changed` shapes, how to read a
  thread's live holder, and how to find an agent's current thread (asked 26 Sep, resurfaced same
  day after a restart). `keyboard.js`'s take-over logic is built and tested against this contract
  as we understand it from the design doc; it's a stub until switchboard confirms it matches.
- deck: `deck/glass/` as the Glass folder, a route to mount it, and `connect-src 'self'` covering
  same-origin `wss:` (asked 26 Sep, resurfaced same day). Nothing written into `deck/` yet,
  pending that answer.
- box: the Compose service for the restricted Docker proxy, the internal network, and vyred joined
  to it.
- gate: the container's egress. Until the Gate exists the network is internal plus whatever the box
  allows; consequential clicks (send, pay, delete) are refused by the hands, not held.

## Changed contracts
- `ctx.upgrade(name, handler)` in `core/modules` and the WebSocket upgrade path
  `/v1/streams/<module>/...` in `core/daemon`: landed on main before this resumed. Glass is its
  first real consumer.
