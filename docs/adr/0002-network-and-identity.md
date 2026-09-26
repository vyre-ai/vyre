# ADR 0002 · Network and identity

Status: accepted, 26 Sep 2026. Supersedes the "served with `tailscale serve`, identified by
Tailscale's identity headers" sentence in SPEC 7.1 and 7.10.

## Context

The Deck lives at `https://<you>.vyre.run`, which resolves to the box's Tailscale address, so
only the user's own devices can reach it. There is no separate login: the person is whoever
Tailscale says is on the other end. Only the box's owner (`network.owner`, a Tailscale login)
is served.

The box is not a quiet machine. Claude Code sessions, watchers and whatever commands they run
all execute on it. Any of them can open a TCP connection to `127.0.0.1` and write any header it
likes. So whatever tells vyred "this request is the owner, on their phone" must be something a
local process cannot produce.

We looked at `tailscale serve` first, because the spec named it. Three ways to use it, and why
each fails:

1. **HTTPS serve to a loopback port, trust `Tailscale-User-Login`.** Serve strips those headers
   from tailnet clients and sets them itself, but any local process can connect straight to the
   loopback port and set them. Forgeable. This is the problem the brief named.
2. **Serve to a unix socket, or add a per-boot secret to the proxied path.** A socket blocks
   other Unix users but not processes of the user vyred runs as, and those are exactly Claude's
   processes. A path secret lives in the serve config, which any local user can read through
   tailscaled's LocalAPI (`tailscale serve status --json` needs no privilege). Both are
   forgeable by the processes we care about.
3. **Serve's certificate.** Serve terminates TLS only for the node's own `*.ts.net` name. It
   cannot present a certificate for `<you>.vyre.run`, so the address the product promises would
   fail the TLS handshake. Raw TCP forwarding (`serve --tcp`) passes our own TLS through, but
   vyred then sees every connection coming from loopback; the real source arrives only in a
   PROXY protocol header, which a local process can forge on the same loopback port.

The source address of a packet that arrived over WireGuard is the one thing a local non-root
process cannot fake. Tailscale authenticates it cryptographically, and tailscaled maps it to a
node and a login (`tailscale whois`).

## Decision

**vyred terminates TLS itself, on the tailnet interface, and identifies each connection by its
source address through `tailscale whois`. `tailscale serve` is not used, and no identity header
is ever read.**

### Listeners

| Listener | Where | Who | Identity |
|---|---|---|---|
| Local API | `~/.vyre/vyred.sock`, mode 0600 | the Unix user vyred runs as: the CLI, the Harness hooks, the Capsule | `x-vyre-caller`, a label only (`cli`, `harness`, `hook`, `mcp`, `capsule`); anything else, `module:*` and `tailnet:*` included, becomes `local` |
| Tailnet | the box's Tailscale addresses, port 443, TLS | people on their own devices | `tailnet:<login>`, from whois of the TCP peer |
| Onboarding | `127.0.0.1:7300` (next free port if taken), plain HTTP | the person installing, before an owner exists | `onboard`, from a one-time token exchanged for a session header |

- **The tailnet listener binds only Tailscale addresses.** On Linux under systemd it is a socket
  unit, `ListenStream=443` with `BindToDevice=tailscale0`, handed to vyred as file descriptor 3.
  vyred needs no capability to own port 443, and no child process (Claude, a watcher) can take
  the port first. Without systemd (a Mac acting as a box, development), vyred binds each
  address from `tailscale status` itself, on `network.port` (default 443).
- **Every connection is identified once, by its peer address.** vyred runs `tailscale whois
  --json <ip>` (cached per address for a minute) and accepts the connection only when all hold:
  - the peer is in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`;
  - whois names a node that is not this box (a connection from the box's own tailnet address
    is a local process, and is refused);
  - the node is not tagged, and its login equals `network.owner`.

  Anything else gets `403 not_owner` with no further detail. The caller passed to
  `registry.call` is `tailnet:<login>`. The node name goes to the log, never into tool input.
- **Headers are ignored, not stripped and trusted.** `Tailscale-User-*`, `X-Forwarded-*` and
  `x-vyre-caller` from the network change nothing. The listener hands vyred's router the caller
  it established itself.
- **The owner's browser is not a trusted client.** It visits other sites too, and a page there
  can make it send a request whose source address is the owner's. So every POST must carry
  `application/json`, which forces a CORS preflight vyred never answers. A browser's `Origin`
  must be this box's own address, and `Host` must be the box's name or one of its tailnet
  addresses (otherwise `421`). A client with no `Origin` (the Mac's vyred, curl) is not a
  browser and passes on identity alone.
- **Self is checked twice**: by the box's own addresses, which are read before the first
  connection on every path, fd 3 included, and by whois naming this node's own stable ID.
- **TLS**: the Let's Encrypt certificate for `<you>.vyre.run`, or the `tailscale cert`
  certificate for the ts.net name when there is no vyre.run name. HSTS on every response.
- **Containers.** An agent's container reaches the host from a bridge address, which is not a
  tailnet address, so it is refused like any stranger. Agents talk to vyred through the Gate.
- **Root is out of scope.** A root process can spoof addresses or read the vault's key. Vyre
  defends the owner against other Unix users and against the owner's own unprivileged
  processes pretending to be the owner on a device.

### Caller classes

Tools and the Gate can tell these apart and must not treat them as equal:

- `tailnet:<login>`: a person, on a device, through a browser or the phone.
- `cli`, `hook`, `capsule` (the socket): the owner's Unix account. Also where Claude's own
  processes live, so floor rule 1 (the user sees final words before anything goes out) cannot
  be satisfied by a socket caller alone. Approvals need `tailnet:*` or an interactive terminal
  the Gate asks directly. (For the gate workstream: this ADR only names the classes.)
- `module:<name>`: another module, through `ctx.call`.
- `onboard`: the onboarding page before an owner exists. Only the onboarding tools.

### Onboarding before an owner exists

- `vyre up` asks vyred (over the socket) for a link. vyred makes a 32-byte random token, keeps
  only its hash in memory, and opens the onboarding listener. The link is
  `http://127.0.0.1:7300/onboard?t=<token>`. On a headless box `vyre up` also prints
  `ssh -N -L 7300:127.0.0.1:7300 <user>@<host>`.
- The token is single use. The first `GET /onboard?t=` exchanges it for a session and
  redirects to `/onboard#s=<session>`, so the token leaves the address bar and history. An
  unredeemed token expires after an hour. A new `vyre up` makes a new link and voids the old
  unredeemed one; open sessions carry on.
- **The session is not a cookie.** Browsers share cookies across every port of 127.0.0.1, and
  `SameSite` treats them as one site, so any other local web server the person visits (another
  Unix user's included) would receive it. The session rides in the fragment, which is never sent
  to a server. The page keeps it in memory and sends it as `x-vyre-onboard` on every tool call,
  or as `?s=` on the event stream, since `EventSource` cannot set headers. A custom header also
  forces a CORS preflight, so no other page can send one.
- The listener serves the onboarding page's files under `/onboard/` to anyone on loopback, since
  they are the open-source Deck and carry nothing secret. Behind the session it serves
  `POST /v1/tools/onboard.*` (plus `projects.catalog`, `projects.create` and `recall.status` for
  step 5) and `GET /v1/events/stream`, limited to `onboard.*` events. It checks `Host` is
  loopback (against DNS rebinding) and that every POST is JSON with a loopback `Origin`.
- **Other Unix users** on the box can reach port 7300 but have neither token nor session. The
  owner's own processes could ask the socket for a link, which `onboard.link` gives only to the
  `cli`, `local` and `capsule` labels. They are already the owner's account, so this gives them
  nothing the socket did not.
- **Closing.** The onboarding listener closes the moment the owner is first served over the
  tailnet address. Closing it earlier, when the name is claimed, could lock out someone whose
  laptop is not on the tailnet yet. If Tailscale is skipped, it stays open (still only the
  onboarding) and `vyre up` prints a fresh link each time.

### Who the owner is

When Tailscale connects, `network.owner` becomes the login of the Tailscale user that owns this
node. When the node is tagged (signed in with an auth key) it has no user, so the onboarding
page shows a claim link on the tailnet address instead: `https://<address>/onboard/claim?c=<code>`,
a one-time code minted for the session holder. The first tailnet login to open it becomes the
owner. Changing owner later is `vyre owner <login>` on the socket.

### Names

- `<you>.vyre.run` is an **A record** at the box's tailnet IPv4 address, DNS only, never proxied
  through Cloudflare. It resolves on the public internet to a `100.x` address that is
  unreachable from anywhere but the tailnet. This leaks the tailnet IP, which is not a secret.
- **Interim**: the user's own Cloudflare API token for the vyre.run zone, from
  `CLOUDFLARE_VYRE_TOKEN` in vyred's environment or the vault item `cloudflare-vyre-token`.
  Never a global key. Code only ever looks up the zone by its configured name (`network.domain`,
  default `vyre.run`) and refuses any record not inside it. Available means no record exists,
  or the one there already points at this box.
- **Later: the hosted name directory.** A small service at `api.vyre.run`, the only thing Vyre
  AI runs. Not built yet. Its design:
  1. **Claim.** The box generates an Ed25519 key (`~/.vyre/names/directory.key`) and sends
     `{ name, publicKey }`. The directory reserves the name for ten minutes.
  2. **Prove the tailnet.** The directory cannot join the tailnet, so it asks for proof that the
     box is a real Tailscale node. It returns a nonce. The box signs the nonce and its directory
     key with the private key of its `tailscale cert` certificate and sends the certificate.
     The directory checks the chain, finds the certificate in Certificate Transparency, and
     verifies the signature, which only that node can make. The tailnet IP is accepted as the
     box states it: pointing a name at an unreachable 100.x address harms no one else. One
     ts.net node holds at most three names.
  3. **Records.** The directory writes `A <name>` and, on request, `_acme-challenge.<name>` TXT
     values for DNS-01, each request signed by the box's key. It never sees a certificate key.
  4. **Keep.** The box renews its claim every 30 days with a signed request; a name idle for 90
     days is released. A lost key is recovered by proving the same ts.net name again.
  5. **Holds nothing else.** No email, no account, no logs beyond the record and its key.

### Certificates

- Let's Encrypt, DNS-01, one certificate per name, ECDSA P-256, account and certificate keys in
  `~/.vyre/certs/` at 0600. DNS-01 works for a name that resolves to a private address, which
  HTTP-01 and TLS-ALPN-01 cannot.
- vyred checks daily and renews at 30 days before expiry, then swaps the certificate into the
  running listener without a restart. A failed renewal retries with backoff and raises
  `certificate.failed` for the Now view once fewer than 14 days remain.
- Fallback: `tailscale cert` for the node's ts.net name, when there is no vyre.run name or DNS-01
  fails. The address is then `https://<node>.<tailnet>.ts.net`. It needs HTTPS enabled in the
  tailnet's admin console, which the onboarding page links to.
- Development uses Let's Encrypt staging (`network.acme: "staging"`).

### The Mac

On a Mac `vyre up` sets role `local` and opens no tailnet listener. It connects to the box as a
client of the box's tailnet listener (`network.box`, the box's address), and the box sees the
Mac as `tailnet:<login>` like any other device. A Mac can instead be the box (`vyre up --box`);
then everything above applies, except the tailnet listener binds its addresses directly.

## Consequences

- vyred owns a TLS listener, an ACME client and certificate renewal. That is code we would not
  need with `tailscale serve`, and it is the price of an unforgeable identity on a custom name.
- Kernel Tailscale is required on the box. In userspace networking mode there is no tailnet
  interface to bind; `vyre up` detects it and says so.
- The owner's own browser on the box cannot use the tailnet address (its source is the box
  itself, which is refused). On a headless box nobody browses locally; on a Mac box the local
  user uses the Capsule and the CLI.
- vyred must reach `tailscale whois`. On Linux that works for any local user.
- No login screen, no passwords, no sessions on the tailnet address.
