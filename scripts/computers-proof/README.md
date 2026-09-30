# computers-proof

Proves an agent's own computer works end to end on the test server, using Vyre's own code:
the image builds, its isolation holds, and Glass can watch, take over and hand back through a
throwaway vyred. Nothing here touches the live Vyre on that server.

## What it checks

1. The computer image builds from `core/computers/image/Dockerfile`.
2. The image's own isolation checks (`core/computers/image/isolation.test.js`, 13 checks) pass on
   a running computer: the agent's uid cannot read the exec environment or `.boot`, Chrome's uid
   cannot open `.boot`, the VNC password or the X cookie, the agent is an untrusted X client.
3. Browser policy (`browser-checks.mjs`): `file://`, `chrome://`, `devtools://` and `view-source:`
   are refused, a page script cannot navigate to `file://` or `chrome://`, downloads go only to
   Chrome's own folder (`/var/lib/vyre/browser/downloads`, readable by the agent's group) and
   never to the agent's home.
4. The functional proof (`proof.mjs`), in a throwaway stack:
   - the pool checks out a computer for a new agent `kit`; labels, limits and hardening are right,
     and no port is published on the host;
   - Glass: a one-use ticket, an RFB 3.8 handshake offering security None only, a real
     framebuffer, saved as `out/glass-desktop.png`;
   - take-over as the person: typed keys and a click through the Glass stream reach the agent's
     terminal (a file its shell wrote), a second viewer's input is dropped, and the agent's hands
     are refused with who holds the keyboard;
   - hand-back: the person's and the second viewer's input are dropped again, the agent's hands
     work again;
   - an agent action through computerd's authenticated `/cdp` route (no raw Chrome port).

## How it is wired

- `proxy-up.mjs` runs `core/dockerproxy` on a free high port, on loopback, pinned to the proof's
  own network, image and label prefix.
- `proof.mjs` starts vyred in its own process over a temp home (config: box role, no Tailscale,
  computers driver docker pointing at that proxy, image `csproof-computer:test`, network
  `csproof-net`, 2 cpus, 2 GB). vyred serves on its unix socket, so the only TCP port is the
  proxy's. `setPeerHosting(true)` is the same seam core's in-process tests use: it lets this
  script be the person at the socket without a terminal. Agent-side calls go through the registry
  as `mcp:agent:kit`.
- `lib.mjs` is the test-side stand-in for the Deck: a WebSocket client over the unix socket, an
  RFB client (Raw encoding) and a PNG writer.
- `computer-up.mjs` makes one computer through the real Docker driver without the rest of vyred,
  for debugging the image on its own.

## Running it

On the test server, from a synced copy of the repo (Docker, Node 22 and rsync are needed):

    rsync -a --delete --exclude node_modules --exclude .git ./ <server>:<folder>/repo/
    cd <folder>/repo && npm ci --no-audit --no-fund
    sh scripts/computers-proof/run.sh <folder> [proxy-port]

`run.sh` builds the image, makes the network, starts the proxy, runs the proof, and removes every
`csproof-` container, volume, network and the image on exit, including on failure. Set
`KEEP_IMAGE=1` to keep the image between runs, `PROOF_HOLD=<seconds>` to keep the computer up after
a failure so it can be inspected by hand. `PROOF_STRICT_HANDS=1` makes hands-chrome's own typing a
hard requirement (see below).

Rules for the shared server: run everything under `nice -n 19 ionice -c3` (run.sh does), one
computer at a time, never a bare `vyre` command, never `docker stop`/`rm` on anything not named
`csproof-`, never `pkill`. Timings are only worth recording at a load under 12; the scripts print
"pending, load N" otherwise.

## Findings this proof turned up

- hands-chrome `Cdp.page()` (`modules/hands-chrome/cdp.js`) attaches to the first target of type
  `page` that is not `devtools://`. Chrome's own WebUI pages (`chrome://omnibox-popup...`) are also
  type `page` and can sort before the tab, so `chrome.type` can look at the popup and answer
  "nothing matches". Restricting the choice to `http(s):`, `about:` and `data:` URLs fixed it in a
  scratch copy. Without `PROOF_STRICT_HANDS=1` the proof records this and proves the agent's input
  path with `Input.insertText` over `/cdp` instead.
- `pool.boot` waits for Xvnc on 5900 only. computerd, and Chrome's first tab, can answer a few
  seconds after `computers.checkout` returns; the proof waits for both.
- Downloads land in `/var/lib/vyre/browser/downloads`, not `/home/agent/Downloads`. That is the
  design (the agent owns its home and could swap a folder there for a symlink); older notes still
  say the home folder.
- The image warns `cannot load font -misc-fixed-medium-r-semicondensed...` for xterm (no
  `xfonts-base`); xterm falls back to a plain bitmap font.
