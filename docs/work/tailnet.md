# tailnet

Branch: work/tailnet · Worktree: ../vyre-tailnet · Decisions: [ADR 0014](../adr/0014-tailnet.md)

## Scope

Use Tailscale fully wherever Vyre already relies on it: Taildrive, Taildrop, Tailscale SSH,
connection health, an exit node for Glass, and Tailnet Lock (built); grants with app
capabilities, machine sharing, a node per agent and Funnel (designed only). Touches
`core/link/health.js`, `core/files/drop.js`, `core/files/drive.js`, `core/computers/egress.js`,
`core/cli/commands/send.js`, `core/cli/commands/box.js`, `core/cli/ssh.js`, `core/cli/tailnet.js`,
`core/names/tailscale.js`, `core/onboard`, `box/compose.yml`, `box/compose.egress.yml`, the Deck's
settings, onboarding and Glass watch, and the Capsule's bridge and launcher.

Vyre never changes the tailnet: no ACL, admin, lock, serve or funnel writes. Tests use a fake
tailscale in temp homes.

## Done

- `link.health` on both roles, at most one check per node per minute, no timers (edeb4b8). Deck
  Network settings and the Capsule show the path and last handshake (e0df7c1).
- Glass paces a relayed or slow viewer to 5 frames a second at lower quality (e525741).
- Taildrop: `files.send`, `vyre send`, the box's inbox receiver and `files.received`
  (849bd4d, 03902bd, 8274e88, d3faa49).
- Taildrive: box shares, the owner-only audit, Mac mount and open, tailscaled sees `/work`
  read-only (41ae09c, 8b75853, 0021b94).
- Tailscale SSH first in `vyre box add` and `move`, with fallback (05f3ba9).
- Tailnet Lock read-only status, onboarding card and Settings row (ff5111c, fc30220).
- Glass egress through the Mac, off by default: PAC, owner-only setting, sidecar
  (7f2519b, 8502ce4, 0097f64, 273b30b).
- ADR 0014, parts 7 to 10 as proposals.

Tests: the targeted files for every piece, 258 of 258 on the merged branch.

## Doing

- Nothing in progress. Waiting on the decisions below and on the real-box checks.

## Next

1. Real-data checks (SPEC section 14), none run yet because the test box is signed out of
   Tailscale and only read-only checks are allowed there:
   - Taildrive: tailscaled in the tailscale image serving a share as the `vyre` user;
     `mount_webdav` mounting 100.100.100.100 unprivileged; the shape of `tailscale.com/cap/drive`
     in whois `CapMap`; the WebDAV path's tailnet segment.
   - Taildrop: the `--verbose` line format of `file get` on 1.102; `TaildropTarget` for a tagged box.
   - Health: a peer-relay `ping` line (the parser guesses its format).
   - Egress: containerboot with in-memory state, `read_only` and `cap_drop: ALL`; Chrome taking a
     `data:` PAC and resolving names through SOCKS5; `docker compose config` on both files.
2. Capsule UI hook for `Launcher.send` (IPC handler, a key on a file row, a longer timeout for
   the call), then a repackage, since the Capsule runs a packaged app.asar.
3. After the user decides: ADR 0014 parts 7 to 10.

## Needs from others

- capsule: wire `Launcher.send` into the app (see Next 2), and repackage for the Taildrive open.
- computers: review the Pacer in `core/computers/glass.js`, the `egress` column and the remake of
  a stopped computer whose egress setting changed (`pool.js`), and `entrypoint.sh`'s PAC check.
- box: review the new `/work` mount in the tailscale service and `box/compose.egress.yml`.
- integrator: the full suite on the merge.

## Decisions needed from the user

1. Taildrive read-only (default) or read-write; whether a share refuses folders holding `.env` or
   keys; whether the box's `projectsDir` moves to `/work/projects`.
2. Taildrop to a tagged box: sign the box in as the owner, or grant file sharing to its tag.
3. Egress: the sidecar design, key renewal (keys expire; OAuth client instead), and that any
   process in any computer can reach the proxy.
4. `link.health` on the box: may any tailnet caller name any node (so the Deck could show each
   paired Mac), or only modules as now.
5. ADR 0014 parts 7 (grants), 8 (sharing), 9 (node per agent), 10 (Funnel).

## Changed contracts

- New tool `link.health` (both roles): `{}` on the Mac, `{ node? }` on the box, answers
  `{ path, relay, latencyMs, lastHandshake, online, checkedAt, cached, why? }`.
- `link.status` on the Mac: `box.stableId`. `link.peers` rows: `stable_id`.
- `glass.open` answers `link: { path, latencyMs }` when known. `computers.watch` takes
  `slow`. `Pool.ticket(agent, surface, { slow })`, and `redeem()` returns `slow`.
- New tools `files.send` (Mac), `files.drive.status|share|unshare|audit` (box, passed through
  from the Mac), `files.drive.url|mount|unmount|open|local` (Mac).
- New events `files.sent`, `files.received`, `drive.exposed`.
- New CLI command `vyre send <file>...`.
- `onboard.tailscale` action `lock`. `core/names/tailscale.js` exports `lockStatus`, `parseLock`.
- `core/cli/tailnet.js` peers carry `ssh`. `box.ssh` may hold a `.ts.net` target.
- New tools `computers.egress.status` and `computers.egress.set` (presence, owner only).
- Config: `files.inbox` (box, default `/work/inbox`), `files.drive.shares`,
  `files.drive.access` (default `ro`), `glass.egress { enabled: false, sites: [] }`.
- Store: `computers_computers.egress` column. Computer env: `VYRE_PROXY_PAC`.
- Compose: the tailscale service mounts `vyre-work:/work:${VYRE_DRIVE_ACCESS:-ro}`. New
  `box/compose.egress.yml` (service `egress`, `computers` profile), with `VYRE_EGRESS_AUTHKEY` and
  `VYRE_EGRESS_EXIT_NODE` in `/srv/vyre/.env`.
