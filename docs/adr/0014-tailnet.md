---
title: ADR 0014: Using the tailnet fully
summary: Which Tailscale features Vyre uses beyond reaching the box, each optional and off by default.
audience: builders
owner: tailnet
status: stable
---

# ADR 0014: Using the tailnet fully

Status: accepted, 27 Sep 2026 (parts 7 to 10 accepted the same day, when the user asked for all ten) · Workstream: tailnet ·
Builds on ADR 0002 (network and identity), ADR 0009 (container hardening), ADR 0012 (cdp-proxy).

## Context

Vyre already stands on Tailscale for four things: the box's tailnet listener, `tailscale whois` as
the only identity (no header is trusted), `tailscale cert` and the name claim it signs, and the
Mac pinning the box's node at pairing. Onboarding runs `tailscale up` (with `--authkey` and
`--operator` on the box), and everything else reads `tailscale status`.

Tailscale offers more that fits what Vyre does: moving files (Taildrop), mounting folders
(Taildrive), SSH without keys (Tailscale SSH), knowing the path a packet takes (ping, status),
exit nodes, Tailnet Lock, app capabilities in grants, machine sharing, ephemeral tagged nodes and
Funnel. This ADR says which Vyre uses, how, and where the user has to decide.

Three rules hold throughout:

1. **Vyre never changes the tailnet.** No ACL edit, no admin setting, no `tailscale lock` write,
   no `tailscale funnel` or `serve`. Where one is needed, Vyre shows the exact steps and the
   person does them. On the user's Mac, Vyre runs only reads (`status`, `whois`, `ping`,
   `lock status`) and `file cp` when the person sends a file.
2. **whois stays the only identity.** A feature that brings in a new kind of caller (a guest, an
   agent's node, the internet) gets its own caller class, never `tailnet:<owner>`.
3. **Light by default** (SPEC principle 8). Nothing here polls while nobody is looking.

The verified facts this rests on, from Tailscale 1.102 on the Mac GUI app and the box container:
`status --json` gives each peer `CurAddr` (empty when not direct), `Relay`, `PeerRelay`,
`LastHandshake`, `TaildropTarget`, `NoFileSharingReason` and `sshHostKeys`; `ping` names the path
it took (`via <ip:port>` or `via DERP(<region>)`); the Mac GUI app refuses every `tailscale drive`
command, so a Mac reaches shares over WebDAV at `http://100.100.100.100:8080`.

## 1. Taildrive: the box's folders on the Mac

**Decision.** The box shares only the folders named in `files.drive.shares` (default `projects`
and `glass-files`), each of which must pass the files guard and hold nothing of Vyre's own
(`~/.vyre`, the vault, the home folder). The Mac mounts a share with `mount_webdav -S` into
`~/Vyre/Box/<share>`, and the Capsule opens a box file from the mount when it is there, falling
back to `files.fetch`.

- tailscaled serves the files from its own container, so `box/compose.yml` mounts `vyre-work`
  into the tailscale service at `/work`, **read-only by default** (`VYRE_DRIVE_ACCESS`,
  `files.drive.access`). tailscaled runs as root with NET_ADMIN, and ADR 0009 says read-only
  where possible. `vyre-home` is never mounted there.
- **Only the owner, enforced where Vyre cannot edit.** Who reaches a share is the tailnet policy:
  `drive:share` on the box, `drive:access` on the person, and a grant carrying
  `tailscale.com/cap/drive`. Vyre cannot write that policy, so it checks it: `files.drive.audit`
  asks whois which online node holds the drive capability, and any that is not a paired Mac is a
  finding (event `drive.exposed`). It runs on demand and once after every share.
- WebDAV serves every file under a shared folder. The files guard does not apply over it, so a
  `.env` inside a project is served to whoever the policy lets in. This is why the audit exists
  and why shares are named, not arbitrary paths.
- Share and unshare are owner actions (the box's terminal, the Capsule, a paired Mac), never an
  agent.

The policy the person adds, in the sample world (the Mac `alex-mac`, the box `tag:vyre-box`):

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

`src` is the Mac alone: with `alex@example.com` every device of theirs gets the shares, and the
audit reports the phone.

## 2. Taildrop: files to the box

**Decision.** `files.send { path }` on the Mac, and `vyre send <file>...`, send with
`tailscale file cp <file> <box-ip>:` to the paired box, found by the stable ID it was paired with,
never by name. The file passes the files guard first, so a key or an `.env` never leaves. Before
sending, the Mac reads the box peer's `TaildropTarget` and `NoFileSharingReason` and, when
Taildrop cannot deliver, says why (`taildrop_unavailable`).

The box keeps one `tailscale file get --wait --loop --conflict=rename --verbose <inbox>` child,
blocked inside tailscaled, so an idle box pays nothing. It starts only when Tailscale is Running
and looks again at most once a minute otherwise. Each file is announced from the `--verbose`
line (written only once the file is complete, with its final name after a rename) as
`files.received`, not from a folder watch, which would fire on half-written files. The inbox
(`files.inbox`, default `/work/inbox`) sits inside a files root, 0700. Nothing opens or runs a
received file: the event names it and that is all.

**Known limit.** Taildrop delivers only between a person's own devices. A tagged box (`tag:server`,
an auth-key install) is not one, and the Mac reports it. The box stays a tagged server, and the
person grants file sharing to its tag in the policy (decided 27 Sep 2026).

## 3. Tailscale SSH for `vyre box add`

**Decision.** When the host in `user@host` is a peer on the Mac's tailnet (by MagicDNS name,
address, first label or HostName, exactly one match, online) and that peer runs Tailscale SSH
(`sshHostKeys` present), `vyre box add` connects to `user@<magicdns-name>` first and says so. If
that connection fails it falls back to the target as typed, and says so. Whichever worked is saved
in `box.ssh`, so `update`, `backup` and `move` reuse it; `move` applies the same preference to the
new host. A `.ts.net` target opens its first connection on the person's terminal, so a Tailscale
SSH check-mode sign-in link is shown, never swallowed. Plain `ssh` is used, not the
`tailscale ssh` wrapper, because Vyre's ssh layer passes its own ControlMaster options.

## 4. Connection health

**Decision.** `link.health` answers
`{ path: "direct"|"relay"|"peer-relay"|"unknown", relay, latencyMs, lastHandshake, online, checkedAt, cached, why? }`.
It reads `status --json` for the peer, then one `ping --c 1 --until-direct=false --timeout 3s`.
Each node is checked at most once a minute and concurrent asks share one check. There is no
timer: it runs only when a surface or a module asks, so it costs nothing while nobody watches.

- On the Mac it is the paired box. On the box it is the calling device, or a paired Mac by node
  ID. A module may name any node, because Glass asks about the viewer the listener identified,
  which is often a phone.
- The Deck's Network settings and the Capsule show "direct 12 ms" or "relayed via fra 80 ms" and
  the last handshake, fetched when shown and at most once a minute while visible.
- **Glass on a relay.** `glass.open` asks `link.health` for a tailnet viewer (waiting at most
  1.5 s, never failing the open) and marks the ticket slow on a relay, a peer relay, or over
  150 ms. The relay then passes the viewer's incremental FramebufferUpdateRequests at most every
  200 ms (5 frames a second), keeping only the latest; input and full-frame requests go straight
  through. The Deck drops to quality 2, compression 6 and shows "relayed". The 200 ms timer exists
  only while a slow viewer is connected, one at a time.
- `netcheck` is not run: it probes every DERP region and is not needed for these answers.

## 5. An exit node for Glass, per site

**Decision.** Some sites refuse or question a datacenter address. The owner may list sites whose
traffic from an agent's Chrome leaves through their own Mac. Off by default.

- **Not the box's own tailscaled.** An exit node applies to a whole node, so setting one on the box
  would send vyred and everything else through the Mac. Instead an optional sidecar
  (`box/compose.egress.yml`, service `egress-node`, `computers` profile) runs a userspace
  tailscaled with `--exit-node=<the Mac>` and a SOCKS5 server on `:1056`, `read_only`,
  `cap_drop: ALL`, in-memory state, on an internal network (`vyre-egress`) that only the gate
  shares, plus the project's default network for the internet. It is not on the computers
  network. It joins as an ephemeral node tagged `tag:vyre-egress`.
- **A gate in front, so every failure is closed.** tailscaled alone fails closed only when the
  Mac is off the tailnet. When the Mac stops offering the exit node, or its route is unapproved,
  its SOCKS5 server dials the site directly from the box (found by the e2e run: 200 OK, the
  datacenter's address). So the computers never reach the sidecar. They reach the gate
  (`core/computers/egressgate.js`, service `egress` in the vyre image, alias `egress` on the
  computers network, port 1055, `read_only`, `cap_drop: ALL`, uid 1000, node built-ins only). It
  reads the SOCKS5 greeting and CONNECT request (no-auth; IPv4, domain or IPv6), then either
  relays the connection byte for byte to the sidecar's `:1056` or answers REP 0x02 ("connection
  not allowed by ruleset") and closes. It never dials a site itself. It allows only when the
  sidecar's LocalAPI (`GET /localapi/v0/status` over its socket, shared read-only through the
  `egress-sock` volume, `TS_SOCKET=/var/run/tailscale/tailscaled.sock` since containerboot's
  default is `/tmp/tailscaled.sock`) shows all of: `BackendState` `"Running"`; exactly one peer
  with `ExitNode: true`; that peer `Online: true` and `ExitNodeOption: true`; and, when the
  field is present, `ExitNodeStatus.Online: true`. Any other state, or any error reading it, is
  a refusal. The verdict is kept 2 s, read on demand only, with no timer while idle. Each change
  of reason is logged once. GET /status on port 1057 answers the verdict, which
  `computers.egress.status` shows as `gate`.
- **Per site, fail closed.** Chrome gets a proxy auto-config script (`VYRE_PROXY_PAC`, a
  `data:` URL, checked by shape in the image's entrypoint) sending the listed sites to
  `SOCKS5 egress:1055` with no DIRECT fallback: when the Mac is away, those sites fail rather than
  show the box's address. WebRTC is held to proxied UDP so a STUN reply cannot leak it either.
  Site names are validated strictly before they reach the script. The PAC is tested only with the
  computer image's Chromium: chromedp/headless-shell ignores every PAC, `data:` or http.
- **Owner only.** `computers.egress.set` needs presence and refuses every agent caller. A change
  applies to a computer the next time it starts: a stopped computer whose script no longer
  matches is made again, keeping its home volume and Chrome profile.
- **A key that survives restarts.** State is in memory, so every start logs in again. A single-use
  auth key fails the first restart with "authkey already used" and the sidecar never comes back.
  The key is a Tailscale OAuth client secret, `tskey-client-...?ephemeral=true&preauthorized=true`
  (preferred: it does not expire), or a reusable, ephemeral, pre-authorized auth key, either for
  `tag:vyre-egress`. The sidecar always passes `--advertise-tags=tag:vyre-egress`, which an OAuth
  client secret requires and a tagged key accepts.
- The auth key and the exit node's name go in `/srv/vyre/.env`, not `vyre.env`: `vyre.env` is
  loaded into vyred's environment, where every Claude session would see the key.

The person's steps: on the Mac, Tailscale menu, Exit Node, Run as Exit Node. In the admin console:
approve the Mac as an exit node; add the tag and grant below; make an OAuth client (scope Auth
Keys, write, tag `tag:vyre-egress`), or a reusable, ephemeral, pre-approved auth key tagged
`tag:vyre-egress` (never single-use). On the box: `VYRE_EGRESS_AUTHKEY` (the client secret with
`?ephemeral=true&preauthorized=true`) and `VYRE_EGRESS_EXIT_NODE=alex-mac` in `/srv/vyre/.env`,
`box/compose.egress.yml` added to `COMPOSE_FILE`, `docker compose up -d`, then `vyre call --tty
computers.egress.set '{"enabled":true,"sites":["portal.northwind.example","*.harlow.example"]}'`
and `vyre call computers.egress.status` (its `gate` says whether the listed sites can go out now,
and why not).

```json
"tagOwners": { "tag:vyre-egress": ["alex@example.com"] },
"grants": [ { "src": ["tag:vyre-egress"], "dst": ["autogroup:internet"], "ip": ["*"] } ]
```

## 6. Tailnet Lock: explained and offered, never enabled

**Decision.** Onboarding (after the Tailscale step) and Settings, Network, explain Tailnet Lock in
two sentences, name its cost, and show the commands the person runs on their Mac, with the box's
lock key filled in: `tailscale lock` to read the Mac's key, then
`tailscale lock init --gen-disablements 2 --gen-disablement-for-support <mac key> <box key>`, and
the two disablement secrets go in the Vault. Vyre reads `tailscale lock status --json` only
(`onboard.tailscale { action: "lock" }`) and never runs `init`, `sign` or anything that writes.
When the lock is on, the card says whether this box is signed.

Why not run it: `lock init` changes every device on the tailnet and can lock the person out of
changes if they lose their signing devices and secrets. That trade is theirs, made where they
can see it.

## Caller classes after parts 7 to 9

The box's tailnet listener now tells four kinds of peer apart. whois stays the only source.

| Peer | Caller | Served when |
|---|---|---|
| the owner, on any device | `tailnet:<login>` | the login is `network.owner` (unchanged) |
| a person from another tailnet | `tailnet-guest:<login>` | guests are on, and the login is listed or holds `vyre.run/cap/guest` |
| an agent's own node | `tailnet:agent:<name>` | agent nodes are on, the node has the agent tag, and the computers module maps its stable ID to a running computer |
| anything else | refused, `403 not_owner` | never |

Tools see `meta.peer = { node, stableId, login, tags, caps, kind, agent? }`. `caps` is the whois
CapMap, as the policy wrote it; Vyre reads it and never writes it. An app capability only ever
narrows or names what Vyre already allows. It never widens a pass, never shows a vault value and
never makes anyone an approver.

## 7. Grants with app capabilities

**Decision.** Vyre reads two of its own app capabilities from whois, each behind its own switch.

- `vyre.run/cap/vault`: `[{ "items": ["northwind-*"], "mode": "relayed"|"sealed"|"any" }]`. With
  `vault.relay.grants: "require"` (default `"off"`, and only with `vault.relay.identity: "whois"`),
  a relayed request needs everything it needed before, then also a grant covering its item and
  mode. The check runs after every existing pass check, so it can only add a refusal: a revoked,
  expired or unapproved pass stays refused whatever the policy says. A new relayed pass carries a
  warning when the holder's login is not covered yet. `vault.grants.status` shows, per holder,
  whether the policy covers their passes.
- `vyre.run/cap/guest`: `[{ "tools": ["glass.open"] }]`. See part 8.

Item and tool patterns are an exact name or a trailing `*` prefix, nothing else.

**Trade-off, still true.** On a company tailnet, whoever edits the policy can grant these. That
is why each switch is off by default, owner only, and why a grant narrows rather than grants.

## 8. Guests from another tailnet

**Decision.** A person the owner shares the box with through Tailscale machine sharing can be
served as a guest, off by default (`network.guests.enable`, presence).

- A guest calls only tools that are both allowed for them (listed in `network.guests.people`,
  or granted by `vyre.run/cap/guest`) and in the fixed `GUEST_SAFE` set: `glass.open`,
  `glass.close` (only sessions the guest opened) and `threads.list`. Every other tool, and every
  route but the Deck's static files, answers `404` as if it did not exist, so a guest learns
  nothing about the rest of the box.
- A guest is never an approver: presence refuses them whatever proof they carry, the Gate's
  `person()` refuses them, link pairing refuses them, and `glass.take` is out of reach.
- The tools are in a new module, `network` (`network.guests.list|add|remove|enable|check`),
  because a module's tools must start with its name. Adding, removing and enabling are on the
  floor's human-only list. `network.guests.check` shows who would be served, from whois of every
  online shared-in peer.

## 9. A tagged node for each agent's computer

**Decision.** When `computers.tailnet.enabled` is on (`computers.tailnet.set`, presence), a
computer joins the tailnet as its own ephemeral node tagged `tag:vyre-agent`, and the names
listener maps that node to `tailnet:agent:<name>` through `computers.node.agent`, which answers
only for a stable ID recorded at join and only while that computer runs.

**whois strengthens the agent key and never replaces it.** Over the tailnet, a request from an
agent's node must also carry the `x-vyre-agent-key` that `threads.vouch` accepts for that same
agent: the node proves which container, the key proves which thread. Off the tailnet, the key
alone works as before. Neither can stand in for the other, because an agent's shell can read its
own key, and a node with no running thread behind it has nothing to act for.

- The auth key is a vault item (`tailscale-agent-authkey`, reusable, ephemeral, pre-approved,
  tagged), fetched by the computers module with a grant. It never goes in the container's env,
  labels, arguments, logs or events. It goes in a request body, only to a separate tailnet port
  that the driver names, never to computerd's port, because computerd runs as the agent's own
  user and the agent could take that port over.
- **Not live yet.** The image runs everything as the agent's user with every capability dropped,
  so nothing in it can start a root tailscaled that the agent cannot read. The computer's side is
  written and tested (`core/computers/image/computerd/tailnet.js`) but not wired in. The minimal
  image change, which amends ADR 0009, is: tini as root, a root-only process on port 7001 with its
  own token, then `setpriv` down to uid 1000 with every capability gone before any agent process
  runs. That needs SETUID and SETGID at start. Until it lands, the switch reports this as its
  `problem`, and nothing is sent.

## 10. Funnel for inbound webhooks

**Decision.** A new module, `hooks`, off by default (`hooks.enable`, presence), takes signed
webhooks from the public internet through Funnel. It is the only part of Vyre that faces the
internet.

- **Its own listener**, on `127.0.0.1:7310` only. tailscaled shares the box's network namespace
  and reaches loopback, which is what Funnel proxies to. Funnel uses port 8443, because vyred binds
  443 on the tailnet addresses itself.
- **One route at a time.** `hooks.open { name, verify: { scheme, header?, secret } }` and
  `hooks.close`, both human-only. Every route checks the sender's own signature (hmac-sha256,
  GitHub, or Stripe with a five-minute tolerance) against a secret the vault holds, in constant
  time; a route without a scheme is refused. Anything else is a bare 404.
- **Never straight to a tool.** A verified request is stored (bounded: newest 500, seven days) and
  announced as `hook.received { route, id, bytes, at }`, without its body. That is all it can do:
  it cannot call a tool, reach the Gate or read any vault item but its route's secret. Watchers
  now run on an event, filtered by payload (`{ "on": "hook.received", "where": { "route": "..." } }`),
  and the runtime hands the watcher the stored delivery. What a watcher then does goes through the
  Gate like anything else.
- Body limit 256 KB, 30 a minute per route and 120 a minute in all, repeats of the same body
  dropped.
- **The person turns Funnel on.** `hooks.status` reads `tailscale funnel status --json`, flags
  routes Funnel does not serve and paths Vyre has no route for, and prints the exact commands.
  Vyre never runs `tailscale funnel`.

## Consequences

- The box stack grows: tailscaled sees `/work` (read-only by default), and an optional egress
  sidecar exists.
- Several parts depend on policy the person writes. Vyre's job there is to explain it exactly and
  to check it (the drive audit, Taildrop's reason, the lock state), not to hold it.
- Parts still unproven on a real tailnet are listed in `docs/work/tailnet.md`, and are to be run
  for real before merge (SPEC section 14).

## Decisions needed

Decided by the lead on 27 Sep 2026, to be built after this merge (docs/work/tailnet.md, "Next"):

1. Taildrive: read-only by default, with a per-share read-write switch behind presence
   (`files.drive.access`); a share refuses any folder the files guard flags anywhere inside it,
   checked at share time and in the audit; the box's `projectsDir` moves to `/work/projects`.
2. Taildrop: the box stays a tagged server; the person grants file sharing to its tag.
3. Egress: the sidecar stays, renewed by a tag-scoped OAuth client; only a computer with egress on
   may use it, through an authenticating front with per-computer credentials. The lock is per
   computer, not per program inside it.
4. `link.health` on the box answers modules and the owner only.

Still open:

5. Part 9: the image change above (root at start, SETUID and SETGID, `setpriv` down), and whether
   the root side must prove itself (an HMAC over a nonce) before vyred sends the key.
6. Part 8: whether a guest may read one thread (`threads.get`), and whether `threads.list`, which
   shows every headless thread, is narrowed for guests.
7. Part 10: keep dropping repeated bodies (it also merges two identical legitimate ones); a
   route's secret grant is module-wide today, not per route.
8. Part 7: whether a policy grant naming a user of another tailnet reaches that user's shared-in
   node's whois caps. Until checked on a real tailnet, `vault.relay.grants: "require"` may refuse
   every shared-in holder.
9. Company tailnets: grants and guests trust whoever edits the policy. Whether onboarding should
   check that the owner alone edits it.
