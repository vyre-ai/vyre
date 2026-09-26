# tailnet

Branch: work/tailnet · Worktree: ../vyre-tailnet · Decisions: [ADR 0014](../adr/0014-tailnet.md)

## Scope

Use Tailscale fully wherever Vyre already relies on it, and wire each feature into the area it
helps. All ten parts of ADR 0014 are built. Each ships off, turns on with one switch, and changes
nothing on the tailnet itself: every ACL, nodeAttr, grant, key, Lock and Funnel step is the user's,
written out under "Steps for the user".

## Done

Round 1 (parts 1 to 6):
- Health: `link.health` (edeb4b8); Glass paces relayed viewers (e525741); Deck and Capsule show it (e0df7c1).
- Taildrop: `files.send`, `vyre send`, the box inbox (849bd4d, 03902bd, 8274e88, d3faa49).
- Taildrive: shares, audit, Mac mount, `/work` read-only in tailscaled (41ae09c, 8b75853, 0021b94).
- Tailscale SSH first in `vyre box add` and `move` (05f3ba9).
- Tailnet Lock read, onboarding card, Settings row (ff5111c, fc30220).
- Glass egress through the Mac (7f2519b, 8502ce4, 0097f64, 273b30b).

Round 2 (parts 7 to 10 and integration):
- One whois parser with tags and app capabilities (9ddba0f).
- Caller classes owner, guest, agent node in the names listener (526dc43); the router limits
  guests and still requires an agent node's key (7e8859e); the `network` module's guest tools (c283d47).
- Vault: `vault.relay.grants` and `vault.grants.status` (0622c88).
- Agent nodes: config (6a58845), the computer's tailnet side (e276166), join and leave in the pool
  (daf3fd7), tools (7757830), the key only to a driver-named tailnet port (020163c). Not live
  until the image change (Decisions needed 4).
- Webhooks: watchers on events with payload filters (0fa5931), the `hooks` module (7dd4a68),
  `vyre hooks` (32b3239).
- Surfaces: one Deck health helper and dots in Chat and Glass (b2af31e), Settings Network rows
  for shares, webhooks, guests, agent nodes and egress (011e0b8), onboarding HTTPS step then Lock
  (53c78d0), Capsule send on option-return and a health dot (ec1543a).
- Presence: the new owner actions on the floor's human-only list (8cb5c6d).

Tests: each branch was green on its own targeted files before merge (round 1: 258 of 258 on the
merged branch; round 2: guests 194 + 26, vault 52, agent nodes 145, hooks 66, surfaces 209 with 6
skipped). The merged round-2 run is in "Doing".

## Doing

PAUSED on the user's order (27 Sep 2026): the Mac was overloaded. Nothing may run on the Mac
(no tests, no node). When the lead sends the go, tests run on the test box, not the Mac.

- All ten parts are merged into work/tailnet. **The merged branch has NOT been tested yet.** Each
  sub-branch was green on its own (counts under Done), but the combined run was killed twice by
  the lead's `node --test` enforcer and then paused. First thing on resume: the targeted run
  below, `nice -n 15`, on the test box.
- The surfaces sub-worktree (../vyre-tailnet-surfaces, branch work/tailnet-surfaces) has
  uncommitted edits from its agent: matching the Settings Network rows to the real tool shapes
  (see "Real shapes" below). Its agent was told to WIP-commit and stop. Merge it into work/tailnet
  once it is committed. The other sub-worktrees are merged and removed.

Targeted run for the merged branch (one command, from the worktree root):
`nice -n 15 node --test core/presence/*.test.js core/harness/*.test.js core/files/*.test.js core/hooks/*.test.js core/watchers/*.test.js core/computers/*.test.js core/computers/driver/*.test.js core/computers/image/computerd/*.test.js core/dockerproxy/*.test.js core/vault/grants.test.js core/vault/presence.test.js core/vault/share.test.js core/vault/relay.test.js core/vault/module.test.js core/vault/surfaces.test.js core/names/*.test.js core/link/*.test.js core/glass/*.test.js core/config/*.test.js core/modules/*.test.js core/cli/*.test.js core/cli/commands/box.test.js core/memory/access.test.js core/gate/*.test.js test/link.test.js test/guests.test.js test/daemon.test.js test/presence-bypass.test.js test/onboard.test.js test/hygiene.test.js deck/js/health.test.js deck/glass/*.test.js local/capsule/lib/*.test.js`.
Likely breakage: `files.drive.share` is now on the floor's human-only list (8cb5c6d), and its
round-1 tests may call it without the `present` verifier from test/helpers.js.

Real shapes the Deck must read (surfaces agent's fix):
- `hooks.list` returns `{ enabled, host, port, listening, error?, routes: [{ name, path, verify: { scheme, header, secret }, opened, deliveries, recent, funnel: { open, close } }] }`.
- `hooks.status` returns `{ routes, node, funnel: { read, why?, serving }, urls, mismatches: [{ kind, route?, harmless, message, fix }], commands, docker }`.
- Switches are the tools `hooks.enable {on}` and `network.guests.enable {on}` (both need presence), not config edits. The CLI is `vyre hooks on|off|open|close|status`.
- `network.guests.list` returns `{ enabled, safe, people: [{ login, tools, allowed }] }`.
- `computers.tailnet.status` returns `{ enabled, tag, applies, problem?, vault: { item, exists, granted, why? }, computers: [{ agent, running, node, stableId }] }`.

## Next

The lead's decisions of 27 Sep 2026, to build on resume, in this order:

1. **link.health on the box: modules and the owner only.** In `core/link/box.js`, refuse
   `tailnet-guest:*` and `tailnet:agent:*`, and any tailnet login that is not the owner. Today any
   caller may ask about itself or a paired Mac. Add a test.
2. **Taildrive:**
   - Read-only by default, with a per-share read-write switch that needs presence: a tool
     `files.drive.access { name, mode: "ro"|"rw" }`, added to HUMAN_ONLY.
     `files.drive.shares` entries become `{ path, access }`.
   - The compose mount stays read-only unless some share is rw. Write the exact `.env` step for
     the user: `VYRE_DRIVE_ACCESS=rw` plus `docker compose up -d`.
   - A share refuses any folder the files guard flags anywhere inside it (`.env`, keys, the
     vault): scan it with the guard at share time, and again in `files.drive.audit`.
   - Move the box's `projectsDir` to `/work/projects`, with a migration that moves existing
     projects out of `vyre-home` and rewrites the paths the projects module stores. Coordinate
     with the projects workstream (docs/work/projects.md).
3. **Taildrop:** the box stays a tagged server. The user step is the file-sharing grant to the
   box's tag (already under "Steps for the user"). Drop the "sign in as the owner" alternative.
4. **Egress:**
   - Renew with a Tailscale OAuth client (tag-scoped, no expiry): `VYRE_EGRESS_AUTHKEY` holds
     `tskey-client-...?ephemeral=true&preauthorized=true`, with `--advertise-tags=tag:vyre-egress`.
   - Only the computer that has egress turned on may use the proxy. Per-computer credentials,
     handed out like the other bootstrap secrets (not in container Env), plus a network policy
     if compose allows.
   - Known limit to report: tailscaled's SOCKS5 server has no authentication, and Chrome sends no
     SOCKS5 credentials. So the plan is a small authenticating front (an HTTP CONNECT proxy with
     per-computer Basic credentials) in front of the sidecar's SOCKS5, answered through
     hands-chrome's CDP (`Fetch.authRequired`), plus a source-address allowlist of
     egress-enabled computers kept by the pool.
   - Inside one computer, any process of the agent's user can still use that computer's
     credential, because it owns Chrome's process. The lock is per computer, not per program.
     Tell the lead before building if that limit is not acceptable.
5. **Part 9's image change** (tini as root, a root-only tailnet side on 7001 with its own token,
   `setpriv` down to uid 1000): waiting on the user; see Decisions needed.

### Verify on first real run

The lead runs these once the user signs the box into Tailscale during onboarding. Until then,
only read-only checks on the test box.

- **Taildrive:**
  - tailscaled serves a share as the `vyre` user.
  - `mount_webdav` works against 100.100.100.100:8080.
  - The shape of `tailscale.com/cap/drive` in whois `CapMap`.
  - The WebDAV path's tailnet segment.
- **Taildrop:** the `file get --verbose` line format on 1.102, `TaildropTarget` for the tagged
  box, and the file-sharing grant's exact form.
- **Health:** the peer-relay `ping` line.
- **Egress:** containerboot with `read_only` and `cap_drop: ALL`, in-memory state, an OAuth
  client secret as the key, Chrome with a `data:` PAC over SOCKS5, and `docker compose config`
  on both files.
- **Grants:** a `vyre.run/cap/vault` or `vyre.run/cap/guest` grant appears in whois `CapMap`,
  including for a shared-in node from another tailnet.
- **Funnel:**
  - The flags `--bg --https=8443 --set-path=...` and `off`.
  - The `funnel status --json` fields.
  - The proxy strips the mount path.
  - Node attributes show in `Self.CapMap`.
- **Agent nodes** (after the image change): a computer joins as `tag:vyre-agent`, and whois maps
  it to its agent.
- **Tailscale SSH:** `vyre box add` to a host with Tailscale SSH on, including check mode.

## Needs from others

- vault: see the tailnet entry in docs/work/vault.md "Needs from others".
- computers: review the Pacer (`glass.js`), the pool's egress remake and agent-node join, the
  `stable_id`/`node`/`egress` columns, and `entrypoint.sh`'s PAC check. Part 9 needs the image
  change in Decisions needed 4, which amends ADR 0009.
- watchers: review the new `on`/`where` event trigger and the `hook.delivery` hand-over.
- capsule: repackage to pick up option-return send, the dot and the Taildrive open.
- box: review the `/work` mount in the tailscale service and `box/compose.egress.yml`.
- integrator: the full suite on the merge.

## Decisions needed from the user

1. Decided (lead, 27 Sep): Taildrive read-only by default with a per-share rw switch behind
   presence; shares refuse flagged folders; projectsDir moves to /work/projects. See Next 2.
2. Decided: grant file sharing to the box's tag. See Next 3.
3. Decided: sidecar kept, OAuth client for renewal, per-computer credentials. See Next 4 and its
   limit.
4. Agent nodes: the image change (tini as root, a root-only tailnet side on 7001 with its own
   token, `setpriv` down to uid 1000, which needs SETUID and SETGID at start), and whether that
   side proves itself before vyred sends the key.
5. Guests: allow `threads.get`; narrow `threads.list` for guests; keep the tools in the new
   `network` module or rename them.
6. Webhooks: keep dropping repeated bodies; per-route secret grants.
7. Decided: `link.health` on the box answers modules and the owner only. See Next 1.
8. Company tailnets: grants and guests trust whoever edits the policy; add an onboarding check
   that the owner alone edits it?

## Steps for the user

Sample names: the owner is alex@example.com, the Mac is `alex-mac` (100.64.0.7), the box is
`tag:vyre-box` (100.64.0.5, `vyre.tail0000.ts.net`). Replace them with the real ones. Merge each
snippet's keys into the one tailnet policy file in the admin console (Access controls).

### Taildrive (box folders on the Mac)

```json
{
  "tagOwners": { "tag:vyre-box": ["alex@example.com"] },
  "hosts": { "alex-mac": "100.64.0.7" },
  "nodeAttrs": [
    { "target": ["tag:vyre-box"], "attr": ["drive:share"] },
    { "target": ["alex@example.com"], "attr": ["drive:access"] }
  ],
  "grants": [
    { "src": ["alex-mac"], "dst": ["tag:vyre-box"],
      "app": { "tailscale.com/cap/drive": [{ "shares": ["projects", "glass-files"], "access": "ro" }] } }
  ]
}
```

Then on the box: `vyre call --tty files.drive.share '{"name":"projects"}'`, and
`vyre call files.drive.audit`. For writes from Finder: `"access": "rw"` in the grant,
`VYRE_DRIVE_ACCESS=rw` in `/srv/vyre/.env`, `files.drive.access: "rw"` in the box's config,
`docker compose up -d`.

### Taildrop (files to the box)

Admin console, Settings: Send Files on. The box stays a tagged server, so grant file sharing to
its tag. The grant's exact form is checked on the first real run:

```json
{ "grants": [ { "src": ["autogroup:member"], "dst": ["tag:vyre-box"],
    "app": { "https://tailscale.com/cap/file-sharing-target": [{}] } } ] }
```

### Tailscale SSH (for `vyre box add`)

On the server, `tailscale up --ssh` (or `tailscale set --ssh`), with a policy SSH rule:

```json
{ "ssh": [ { "action": "accept", "src": ["alex@example.com"], "dst": ["tag:vyre-box"], "users": ["autogroup:nonroot"] } ] }
```

### HTTPS (a ts.net address)

Admin console, DNS, HTTPS Certificates, Enable HTTPS. Onboarding shows this step when
`tailscale cert` fails for this reason.

### Tailnet Lock (optional)

On the Mac: `tailscale lock` to read its key (`tlpub:...`); the box's key is on the onboarding
card and in Settings, Network. Then, on the Mac:
`tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> <box key>`.
Save both disablement secrets in the Vault.

### Glass egress through the Mac

1. On the Mac: Tailscale menu, Exit Node, Run as Exit Node.
2. Admin console: Machines, alex-mac, Edit route settings, Use as exit node. Settings, OAuth
   clients: Generate, scope Auth Keys (write), tag `tag:vyre-egress`. The client secret does not
   expire, so nothing needs renewing.
3. Policy:
   ```json
   {
     "tagOwners": { "tag:vyre-egress": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-egress"], "dst": ["autogroup:internet"], "ip": ["*"] } ]
   }
   ```
4. On the box, in `/srv/vyre/.env` (not `vyre.env`): `VYRE_EGRESS_AUTHKEY=tskey-client-...?ephemeral=true&preauthorized=true`,
   `VYRE_EGRESS_EXIT_NODE=alex-mac`, and `COMPOSE_FILE=box/compose.yml:box/compose.egress.yml`.
   Then `docker compose up -d` and
   `vyre call --tty computers.egress.set '{"enabled":true,"sites":["portal.northwind.example"]}'`.

### Vault passes authorized by the policy (grants)

The holder dana@northwind.example reaches the box through machine sharing:

```json
{ "grants": [ { "src": ["dana@northwind.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:7301"],
    "app": { "vyre.run/cap/vault": [ { "items": ["northwind-*"], "mode": "relayed" } ] } } ] }
```

Then in the box's config: `"vault": { "relay": { "identity": "whois", "grants": "require" } }`,
restart vyred, and check with `vyre call vault.grants.status`. `7301` is `vault.relay.port`.

### Guests from another tailnet

1. Admin console: Machines, the box, the "..." menu, Share, invite sam@harlow.example.
2. Either list them:
   `vyre call --tty network.guests.add '{"login":"sam@harlow.example","tools":["glass.open","glass.close","threads.list"]}'`,
   or grant them:
   ```json
   { "grants": [ { "src": ["sam@harlow.example"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"],
       "app": { "vyre.run/cap/guest": [ { "tools": ["glass.open", "glass.close", "threads.list"] } ] } } ] }
   ```
3. `vyre call --tty network.guests.enable '{"on":true}'`, then `vyre call network.guests.check`.

### A tagged node for each agent (after the image change)

1. Policy (and remove any allow-all `"src": ["*"]`, which covers tags):
   ```json
   {
     "tagOwners": { "tag:vyre-agent": ["alex@example.com"] },
     "grants": [ { "src": ["tag:vyre-agent"], "dst": ["tag:vyre-box"], "ip": ["tcp:443"] } ]
   }
   ```
2. Admin console, Settings, Keys: a reusable, ephemeral, pre-approved key tagged `tag:vyre-agent`.
3. `vyre vault put tailscale-agent-authkey`, then `vyre vault grant tailscale-agent-authkey computers`.
4. `vyre call --tty computers.tailnet.set '{"enabled":true}'`.

### Webhooks through Funnel

1. Policy: `"nodeAttrs": [ { "target": ["tag:vyre-box"], "attr": ["funnel"] } ]`, and HTTPS on (above).
2. On the box:
   ```
   vyre hooks on
   vyre vault put northwind-orders-hook
   vyre vault grant northwind-orders-hook hooks
   vyre hooks open northwind-orders --scheme hmac-sha256 --header x-northwind-signature --secret northwind-orders-hook
   cd /srv/vyre && docker compose exec tailscale tailscale funnel --bg --https=8443 --set-path=/hooks/northwind-orders http://127.0.0.1:7310/hooks/northwind-orders
   ```
3. The sender posts to `https://vyre.tail0000.ts.net:8443/hooks/northwind-orders`. Check with
   `vyre hooks status`.
4. To close: `vyre hooks close northwind-orders`, then
   `tailscale funnel --https=8443 --set-path=/hooks/northwind-orders off`; after the last route,
   `tailscale funnel --https=8443 off`.

## Changed contracts

Listed by the area they touch, so the merge can go in order. Everything below is off by default.

- **link** (own): tool `link.health`; `link.status` box gains `stableId`; `link.peers` rows gain
  `stable_id`; `parseWhois`/`capValues` in `core/link/transport.js` (whois carries `tags`, `caps`);
  link pairing refuses `tailnet-guest:*` and `tailnet:agent:*`.
- **names** (box's listener): `identifier` returns `kind` (owner, guest, agent); callers
  `tailnet-guest:<login>` and `tailnet:agent:<name>`; peer meta `{ node, stableId, login, tags,
  caps, kind, agent? }`; `core/names/guests.js` (`GUEST_SAFE`, helpers); `lockStatus`, `parseLock`,
  `peers`, `parsePeers` in `core/names/tailscale.js`.
- **daemon**: guests reach only their allowed tools within `GUEST_SAFE`, 404 otherwise;
  `tailnet:agent:*` also needs a matching `x-vyre-agent-key`; `tailnet-guest:` is a label the
  socket cannot claim.
- **network** (new module, box): `network.guests.list|add|remove|enable|check`; events
  `guest.added`, `guest.removed`; config `network.guests { enabled: false, people: {} }`.
- **presence**: HUMAN_ONLY gains `files.drive.share|unshare`, `network.guests.add|remove|enable`,
  `hooks.enable|open|close`, `computers.tailnet.set`, `computers.egress.set`; presence refuses
  `tailnet-guest:*` whatever the proof.
- **gate**: `person()` refuses guests and agent nodes.
- **memory**: `viaTailnet` no longer reads `tailnet:agent:*` as the owner.
- **vault**: config `vault.relay.grants` (`"off"`|`"require"`); whois relay meta gains `peer`;
  tool `vault.grants.status`; `vault.pass.create` may return `warning`; exports
  `relay.VAULT_CAP`, `relay.grantCovers`, `whoisMeta`.
- **files**: tools `files.send`, `files.drive.status|share|unshare|audit|url|mount|unmount|open|local`;
  events `files.sent`, `files.received`, `drive.exposed`; config `files.inbox`,
  `files.drive.shares`, `files.drive.access`; CLI `vyre send`.
- **glass**: `glass.open` answers `link`; `glass.close` from a guest closes only its own sessions;
  config `glass.egress`.
- **computers**: tools `computers.egress.status|set`, `computers.tailnet.status|set`, internal
  `computers.node.agent`; events `computer.joined`, `computer.left`; `computers.watch` takes
  `slow`; `Pool.ticket(..., { slow })`; columns `egress`, `stable_id`, `node`; computer env
  `VYRE_PROXY_PAC`; `Inspection.ports.tailnet` (optional); manifest `needs.vault`
  `["tailscale-agent-authkey"]`; config `computers.tailnet`; new, unwired
  `image/computerd/tailnet.js`; `entrypoint.sh` PAC check.
- **watchers**: watcher.json `on` and `where` (schedule `"event"`), run trigger `"event"`,
  `watchers.test` takes `event`, runtime dep `listen`, `folder.matches` exported, the
  write-a-watcher skill documents it.
- **hooks** (new module, box): `hooks.enable|open|close|list|status|delivery`; events
  `hook.received`, `hook.opened`, `hook.closed`; table `hooks_deliveries`; config `hooks`;
  CLI `vyre hooks`.
- **onboard**: `onboard.tailscale` action `lock`; the HTTPS step shown as plain steps, Lock after it.
- **cli / install**: `vyre box add` and `move` prefer Tailscale SSH; `core/cli/tailnet.js` peers
  carry `ssh`; `ssh.js` opens `.ts.net` targets interactively first.
- **deck**: `deck/js/health.js` (one formatter, dots in Chat and Glass headers); `deck/js/lock.js`;
  Settings Network rows; new fixtures `files.json`, `hooks.json`, `network.json`, `link.json`.
- **capsule**: IPC `capsule:send-file`, preload `sendFile`, option-return on a file row,
  `SEND_TIMEOUT`, the box dot, Taildrive-first open.
- **box**: the tailscale service mounts `vyre-work:/work:${VYRE_DRIVE_ACCESS:-ro}`; new
  `box/compose.egress.yml`.
- **config**: defaults for `glass.egress`, `computers.tailnet`, `hooks`, `network.guests`.

Suggested merge order: link and names, daemon and presence, vault, files, computers, watchers and
hooks, then deck, capsule and onboard. They are one branch here, so this matters only if the
integrator splits it.
