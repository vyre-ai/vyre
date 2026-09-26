# box

Branch: work/box · Worktree: ../vyre-box · Milestone: M5 · Wave 1

## Scope

Owns `core/names/`, `core/cli/commands/up.js` (a richer `vyre up` that replaces the one in
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
