# link

Branch: work/link · Worktree: ../vyre-link

## Scope

Owns `core/link/`, `core/files/`, `core/cli/commands/link.js`, `test/link.test.js`. The Mac's
vyred (role `local`) and the box's vyred (role `box`) work as one system over the tailnet only.

## Done

- `link` module. Pairing: the Mac calls `link.pair.request` on the box and gets a code, and the
  owner approves it on the box with `link.pair.approve`. The Mac polls `link.pair.poll` for the
  link key. The box keeps sha256(key) and the Mac's node. The Mac keeps the key in
  `~/.vyre/link.json` (0600) and pins the box's node stable ID.
- `ctx.remote(tool, input)` in core/modules, carried by the internal `link.remote`. `link.call`
  does the same for surfaces. `/v1/link/events` proxies the box's event stream.
- Degrades cleanly: fail fast while the box is down, backoff, `link.lost` and `link.connected`,
  `link.down` on the proxied stream.
- `files` module with search, stat, preview and fetch, confined to roots through realpath.
- Tests: two vyreds in temp homes, with the tailnet simulated at both ends (`test/link.test.js`).

## Tools

Mac: `link.status`, `link.pair {box}`, `link.unpair`, `link.call {tool, input}`.
Box: `link.status`, `link.pending`, `link.pair.approve {code}`, `link.pair.deny {id}`,
`link.peers`, `link.unpair {id}`, plus `link.pair.request`, `link.pair.poll` and `link.hello`,
which the Mac calls.
Files: see CHANGELOG; the shapes were sent to capsule.

## Needs from others

- box: the names listener should pass the whois result as `meta.peer = { node, stableId, login }`
  into `registry.call(tool, input, caller, meta)`, through `handler(policy)(req, res, caller, peer)`.
  Until it does, the box cannot tell which node is calling. Two things are affected. Approval is
  limited to the box's own terminal. The link key is also not tied to a node on the box; the
  Mac's pin still holds.
- box: `callerKind("tailnet:<login>")` returns the whole string, so a tool's `callers` list
  cannot name tailnet callers. The link checks in `run` for now.

## Known limits

- Any of the owner's devices can call box tools directly, as ADR 0002 decides. On the box,
  pairing gates only the link's own tools. What it adds is consent, a pin on the Mac and
  revocation.

## Next

1. The real check against the box stack in /srv/vyre, with roots at /srv/vyre/work.
2. Deck: show `link.pending` with approve and deny, once peer meta lands.
