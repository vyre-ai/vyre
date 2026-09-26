# box

Branch: work/box · Worktree: ../vyre-box · Milestone: M5 · Wave 1

## Scope

Owns `core/names/`, `core/onboard/` (the `onboard` module: its tools must start with its name),
`core/cli/commands/up.js` (a richer `vyre up` that replaces the one in
`core/cli/commands/daemon.js`; remove it there in the same commit), `scripts/install-box.sh`,
`docs/adr/0002-network-and-identity.md` (write it first).

`vyre up` on a Linux server ends at `your address: <you>.vyre.run`, reachable only from the
user's own tailnet, with HTTPS and no separate login.

- **Tailscale.** Detect it; if missing, print the one install command and stop (never install
  software without asking). `tailscale up` with the user's auth in their own browser. Read the
  node's tailnet IP and MagicDNS name.
- **Serving.** vyred listens on the unix socket only. Expose the Deck with `tailscale serve`
  proxying to a loopback TCP port. That port is reachable by every local user, and Tailscale
  identity headers can be forged by a local process, so the ADR must settle how requests are
  trusted: e.g. listen on a socket `tailscale serve` can proxy to, or a per-boot secret header
  that only the serve config carries. Every request carries a caller identity into
  `registry.call`. Only the box's owner (config `network.owner`, a Tailscale login) is served.
- **Names.** `<you>.vyre.run` is an A record at the tailnet IP (DNS only, never proxied). For now
  it is created with the user's Cloudflare API token scoped to the vyre.run zone
  (`CLOUDFLARE_VYRE_TOKEN`; the user adds it to their own env; never ask for it in chat, never
  use a global API key). Design the later hosted name directory (claim a name, prove tailnet
  ownership) in the ADR, and don't build it yet.
- **Certificates.** Let's Encrypt by DNS-01 against Cloudflare, with renewal. Or `tailscale cert`
  for the ts.net name as the fallback.
- **Mac role.** On a Mac, `vyre up` sets role `local` and connects to the box over the tailnet.

## Onboarding (with the deck stream)

The user installs from the landing page and sets Vyre up in a browser, like n8n on a server
(spec section 1, "Install and onboarding"). Box owns the steps' tools; deck owns the screens.
Tools: `onboard.status`, `onboard.claude` (setup-token or API key into the Vault),
`onboard.tailscale` (detect, start `tailscale up`, report its login URL, wait for the node),
`onboard.name` (check, reserve, DNS, certificate), `onboard.finish`. Before an owner exists,
vyred serves only `/onboard` and these tools, on loopback, behind the one-time token; after, the
loopback listener closes. A headless box prints the `ssh -L` line to reach it.

## Needs from the user (stop and ask when you reach them)

A Linux box on the tailnet with SSH, the Cloudflare token in the env, and the name to claim.

## Done when

From a phone on the tailnet, `https://<you>.vyre.run/v1/health` answers with a valid
certificate, and from off the tailnet it does not resolve to anything reachable.

## Done
- `b45e955` ADR 0002: vyred terminates TLS on the tailnet interface and identifies callers by
  `tailscale whois` of the source address. `tailscale serve` is not used: it cannot present a
  vyre.run certificate, and each serve variant leaves a forgeable local hop. `docs/INSTALL.md`
  covers the owner's own account (not a system user), folders, units, upgrade, uninstall and
  backup. SPEC 7.1 and 7.10 updated to match.
- `a658bf8` core: `ctx.handler(policy)`, `config.save`, new paths, `supervisor` in health.
- `9cc1352` ACME DNS-01, CSR, Cloudflare (zone-guarded), cert store. Live: `_vyre-test`
  records created, updated and deleted (0 left); LE staging account created, and the order was
  rejected for the underscore label (`rejectedIdentifier`).
- `bc287b4` `names` module: tailnet listener, whois identity, claim, fallback, renewal, owner,
  claim code. Live on the Mac: it bound only the tailnet IPs, and self with forged headers got
  403. Real whois passed the owner's devices and refused another login's node.
- `5250bf5` `onboard` module: tools plus the one-time loopback page (cookie, Host and Origin checks).
- `a56c44e` systemd plan, dry run, backup and restore, `scripts/install-box.sh`.
- `bb579ac` `vyre up` (link, ssh line, restart on upgrade, `--box`, `--connect`, `--system`),
  `vyre uninstall --system`, `name`, `owner`, `backup`, `restore`, `daemon`.

- `f861c35` review fixes: tailnet POSTs must be same-origin JSON and Host is checked; socket
  `x-vyre-caller` can no longer claim `module:*` or `tailnet:*`; the loopback session moved from
  a cookie to the `x-vyre-onboard` header; self is checked by stable ID too.

- Docker Compose box (`box/`): a `tailscale` sidecar is the only way in, vyred runs as uid 1000
  in its network namespace so whois identity holds, volumes `vyre-home` and `vyre-work`, and the
  `vyre` host wrapper. On a real Ubuntu box `vyre up` built and started it and printed the
  onboarding link and the `ssh -L` line. ADR 0002 amended; systemd is now the no-Docker path.

## Doing
- `scripts/install-box.sh` and `docs/INSTALL.md` rewritten for Docker (`/srv/vyre`,
  `vyre update`, volume backup, `--uninstall [--purge]`, Chat and `computers`); not yet run on a box.

## Next
1. On a real Linux box: run the installer, then the socket unit and fd 3, `tailscale up` as
   operator, a real DNS-01 certificate for the user's name, and the phone check from Done when.
2. Wire `onboard.claude` to the vault's real `vault.put` once it merges.
3. The hosted name directory (designed in ADR 0002; not built).

## Needs from others
- vault: `vault.put { name, value }` callable by `module:onboard`; items `claude-setup-token`,
  `anthropic-api-key`, `cloudflare-vyre-token` (read by `names` through `ctx.vault.fetch`).
- deck: `deck/onboard/`, with everything it loads under `/onboard/` (loopback serves nothing else).
- switchboard: hand the vault's `claude-setup-token` to headless sessions as their credential.
  Make the assistant at `onboard.finish` once `agents.create` exists.
- gate: approvals should require a `tailnet:*` caller, since socket callers include Claude's own
  processes (ADR 0002, caller classes).
- user: a Linux box on the tailnet (not the development Mac), `CLOUDFLARE_VYRE_TOKEN` in its `~/.vyre/env`,
  and the name to claim.

## Changed contracts
- `ctx.handler(policy) -> (req, res, caller)`: new, in core/modules and core/daemon.
- `config.save(patch, root?, live?)`, and `paths()` gains certs, names, models, env.
- `GET /v1/health` gains `supervisor`.
- `vyre up` moved from `core/cli/commands/daemon.js` to `up.js`.
- New tools `onboard.*` and `names.*` (shapes sent to deck); events `onboard.stepped`,
  `onboard.finished`, `name.claimed`, `name.released`, `certificate.issued`, `certificate.failed`,
  `owner.seen`, `owner.changed`.
- Caller strings: `tailnet:<login>` for people on devices, `onboard` for the loopback page.
  Socket `x-vyre-caller` is limited to `local`, `cli`, `harness`, `hook`, `mcp` and `capsule`.
  Anything else is `local`, so a socket client cannot pose as a module.
- Onboarding session: the redirect goes to `/onboard#s=<session>`, the page sends
  `x-vyre-onboard`, and the event stream takes `?s=` (sent to deck).
