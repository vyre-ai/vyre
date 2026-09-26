# ADR 0008 · The install journey

Status: proposed, 26 Sep 2026. Builds on ADR 0002 (network and identity). Amends SPEC section 1
("Install and onboarding") where noted. The one-page version for users is
[docs/JOURNEY.md](../JOURNEY.md).

## Context

SPEC section 1 promises an n8n-style install: one command, then a browser. The pieces exist in
separate branches: the Docker box, `install-box.sh` and the `onboard.*` tools (box), the
onboarding screens (deck), the Mac-to-box link (link), and the published files (release). Each
works; nothing yet walks a person from "I have a Mac and a server" to "my assistant just said
hello" without them knowing what SSH, Docker or a tailnet is. This ADR decides that walk.

The person we design for owns a Mac, has Claude Code, and may have rented a server they have
never logged into. They do not have a Tailscale account, a Cloudflare token or a domain.

## Decision

### 1. Three doors, one journey

| Door | Where | Command | Who it suits |
|---|---|---|---|
| **A. From the Mac** (primary) | Mac | `npm i -g vyre`, then `vyre up` | anyone with a Mac and a server they can SSH to |
| B. On the server | Linux | `curl -fsSL https://vyre.run/install.sh \| sh` | people already in a server's shell |
| C. The Mac is the box | Mac | `vyre up --box` | trying Vyre with no server at all |

`https://vyre.run/box` serves the same script as `install.sh`, so both spellings work. The landing
page leads with door A.

**Door A is the primary path**, because the Mac is where the person already is, it has a browser,
and it can do the server's chores over SSH. The person never opens a shell on the server.

`vyre up` decides by role and state:

| Where | State | What `vyre up` does | Prints / opens |
|---|---|---|---|
| Mac | no box known | starts vyred (local), finds a Vyre box among the tailnet's peers; if none, asks "Where should Vyre run?" (a server, this Mac, or I have one) | the question, then walks the chosen door |
| Mac | box known | starts vyred (local), checks the box answers, pairs if not paired | `Vyre is ready.` block (section 6) |
| Mac | `--box` | as a Linux box, but vyred binds tailnet addresses itself (ADR 0002) | opens the onboarding link in the browser |
| Linux, Docker stack | before onboarding | the host wrapper starts the stack, then `vyre up` in the container | the one-time link and the `ssh -L` line |
| Linux, Docker stack | after | same | `your address: https://…` |
| Linux, npm only | any | runs vyred as the user; says the Docker installer is the supported box | as the Docker row, plus that pointer |

Without a terminal to ask on (`vyre up | cat`, CI), the Mac prints the three commands instead of
asking. `vyre up --json` prints one JSON object (`{ role, url, port, ssh, address, box }`) so a
caller never scrapes text; `vyre box add` uses it.

### 2. `vyre box add user@host`

The glue this ADR adds. Run on the Mac; everything on the server happens through SSH.

1. **Mac first.** Check this Mac is on a tailnet (`tailscale status --json`, `BackendState`
   `Running`). If Tailscale is missing, say so with the download link and stop; if it is
   installed and signed out, say "open Tailscale and sign in". The Mac's login is remembered as
   the expected owner. Vyre never installs Tailscale on the Mac: the App Store and the signed
   package both need the person's approval anyway.
2. **Reach the server.** `ssh -o BatchMode=yes user@host true`. If a key is not set up, fall back
   to one interactive SSH connection held open with `ControlMaster`, so a password is asked for
   once. The control socket lives in a 0700 folder under `/tmp` (socket path length).
3. **Look before touching.** One SSH call reads `uname -s`, `docker compose version`, `sudo -n
   true`, `/dev/net/tun`, and whether `/srv/vyre` already holds a box. The Mac shows a plan
   ("will install Docker with get.docker.com, create /srv/vyre, add /usr/local/bin/vyre") and
   asks once. A no stops with nothing changed.
4. **Install.** Copies the installer that shipped in this npm package (so the box files match
   the Mac's version) and runs it as `ssh -t user@host sh <tmp> --yes`, `-t` so sudo can ask
   for a password on the person's own terminal. `--yes` is safe because step 3 asked.
5. **Link.** `ssh user@host vyre up --json` returns the one-time link. The Mac opens
   `ssh -N -L 7300:127.0.0.1:7300` itself (same port both sides, as ADR 0002 requires; if 7300
   is taken on the Mac it says what holds it and stops) and opens the link in the browser. The
   terminal says "Finish in your browser. I'll wait here."
6. **Wait.** Every 5 seconds, `ssh user@host vyre call onboard.status` over the held connection,
   printing one line per step as it completes. Ctrl-C leaves the box as it is; running `vyre box
   add` again resumes from where it stands, because every step is worked out from the box.
7. **Finish on the Mac.** When the address serves, close the tunnel, save `network.box` and
   `box.ssh` (`user@host`, for `vyre box update|backup|move|remove`), start pairing and ask for
   the approval in the Deck (section 7), and print the ending. A box that already finished onboarding goes
   straight here, so running `vyre box add` again is how a person resumes.

Door B joins the same journey at step 5: its `vyre up` prints the link, and when the person later
runs `vyre up` on their Mac, the Mac finds the box on the tailnet and does step 7.

### 3. Tailscale

- **Box.** The `tailscale` container starts at `NeedsLogin` and waits. The onboarding's Connect
  runs `tailscale up` as operator; the page shows `AuthURL` from `tailscale status --json`,
  re-read on every poll rather than cached, since Tailscale does not document how long it lives.
  The person signs in in the same browser. If they already signed the Mac in, the browser is
  already signed in to Tailscale and it is one click.
- **No account yet.** The login page offers Google, Microsoft, GitHub and Apple; signing in
  creates the tailnet. The screen says so in one line: "No Tailscale account? Sign in with
  Google, GitHub, Apple or Microsoft. It makes one, free for personal use."
- **Auth keys** are the headless option (`TS_AUTHKEY` in `/srv/vyre/.env`). The page says to make
  it **untagged**: an untagged key signs the node in as the person who made it, so whois names
  an owner. A tagged node has no user, and falls back to ADR 0002's claim link.
- **Names.** The box's Tailscale hostname is `vyre` (`VYRE_TS_HOSTNAME`; a second box is
  `vyre-2`). With MagicDNS, which is on by default, it is `vyre.<tailnet>.ts.net`.
- **How the Mac finds the box.** `network.box` when set. Otherwise `link.find`: the online peers
  in `tailscale status --json` that answer `GET /v1/health` as a box, at the name on their
  certificate. One answer: that is the box. Several: `vyre up` lists them and asks. The vyre.run
  name, when there is one, is only ever a nicer spelling of the same address.
- **The Mac is never changed.** Vyre does not run `tailscale up`, `set` or `logout` on a Mac.

### 4. Names and certificates

**v0.1 ships the ts.net address as the default, and no name directory.**

- The address is `https://vyre.<tailnet>.ts.net`, from `tailscale cert` (the `names.fallback`
  path in ADR 0002). It needs "HTTPS Certificates" turned on in the tailnet's DNS settings,
  which is off by default. The address screen checks, and when it is off shows one button,
  "Turn on HTTPS", linking to `https://login.tailscale.com/admin/dns`, and "Check again". It
  warns once that this publishes the machine name in public Certificate Transparency logs.
- **With a Cloudflare token, a name.** When the box has a token (`CLOUDFLARE_VYRE_TOKEN` or the
  vault item `cloudflare-vyre-token`) or `network.domain` is set, the address step claims
  `<you>.vyre.run` (or a name in the person's own zone) as ADR 0002 describes, and ts.net is the
  fallback. Without one, ts.net is the default and "Your own domain" is a collapsed choice that
  takes a token scoped to one zone. The project's own vyre.run names use this path until the
  directory exists; at that scale the Let's Encrypt limit below does not bite.
- **The vyre.run name directory waits for v0.2**, for three reasons that are not code:
  1. Let's Encrypt allows 50 new certificates per registered domain per week, shared by every
     user of vyre.run. Launch would stall at about 50 people. Escaping it needs vyre.run on the
     Public Suffix List (months, no SLA) or a Let's Encrypt override (weeks).
  2. The directory's proof of tailnet membership (ADR 0002) signs with the `tailscale cert`
     key, so the person has already turned on HTTPS and already has a working ts.net address.
     The directory gives them a nicer name, not fewer steps.
  3. A free Cloudflare zone holds 200 records.

  Its design in ADR 0002 stands, on Cloudflare Workers with D1 (names must be unique with strong
  consistency, which KV is not). Start the PSL request and the Let's Encrypt override now.
- **SPEC change.** Step 1 ("You") no longer reserves a name; it takes the person's name and their
  assistant's name. Step 4 ("Your address") gets the certificate and switches the page to the
  address. `onboard.you` stops calling `names.check`.

### 5. Claude sign-in

As box built it: the page offers the subscription (`claude setup-token`, driven through a pty
on the box; the page opens Claude's sign-in in the browser and takes the code the person pastes)
or an API key. The credential goes into the vault as `claude-setup-token` or
`anthropic-api-key`, granted to `agents`, and reaches headless sessions as
`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. Nothing is typed into a terminal. The Mac's own
`claude` sign-in is never read or copied.

### 6. The first five minutes, and the ending

`onboard.finish` does the work that makes the ending real, in this order:

1. **The assistant is created**: `agents.create { kind: "assistant", name: <slug>, title: <what
   they typed>, auth: { vault: "claude-setup-token", fallback: "anthropic-api-key" } }`. The
   slug is the typed name lowercased to `[a-z0-9-]`, since agent names must be; the typed name is
   kept for display.
2. **It greets them**: `agents.ask { wait: false }` with a fixed first message asking it to
   introduce itself in two sentences, say how many sessions it can see, and suggest one
   project. The finish screen streams that reply.
3. **History**: the box indexes the box's sessions (none, on a fresh box). The Mac's sessions
   stay on the Mac and are indexed there by the Mac's vyred, in the background at low priority;
   the box reaches them through the link. The history screen on a fresh box says "Your Mac's
   sessions appear here when you connect your Mac", not "no sessions".
4. **The first project** is picked on the history screen, from whichever catalogue is reachable.
   Skipping is fine; the assistant's greeting suggests one.
5. **The Mac.** Through door A the Mac is already connected, so the card says "Connected:
   <mac name>". Otherwise it shows `npm i -g vyre && vyre up` and the Capsule download.
   `vyre capsule install` downloads `Vyre-mac.zip` for this version from `vyre.run/box/`,
   checks it against `SHA256SUMS`, and unpacks it to `~/Applications/Vyre.app` (never
   `/Applications`, never with sudo).
6. **The phone.** Two QR codes side by side: Tailscale's app, and the address's `/now`. The
   line under them names the login to sign in with.

**The ending is one screen and one block of text, the same everywhere.** The browser shows the
assistant's greeting at the top, three ticks (Mac, phone, history) under it, and one button,
"Open Vyre". The Mac's terminal ends with:

```
  Vyre is ready.

    your box        https://vyre.<tailnet>.ts.net
    your assistant  Juno · in the Capsule and on your phone
    next            vyre      (your projects and threads)
```

and `vyre up` prints the same block every time after, so "is it done?" always has one answer.

### 7. Pairing the Mac and the box

**The Mac shows a code and the box's owner approves it** (the link module, `core/link`). The first
connection learns the box's node; everything after is pinned to it, and the approval on that very
box is what makes the pin trustworthy. Approval comes from the box itself (`vyre link approve
<code>`) or from another of the owner's devices in the Deck, never from the Mac asking.

- **Approval is in the Deck, with a passkey.** Onboarding ends by enrolling the owner's first
  passkey (box, `onboard.finish` returns a one-time `passkeyUrl`). Both doors then start pairing
  and ask the person to approve the Mac in the Deck, which names it. SSH is never used to
  approve: whatever the host wrapper could pass into the box's container, a process already in
  that container (Claude's sessions run there) could pass too.
- **Door B shows the code.** `vyre up` on the Mac finds the box (`link.find`: online peers of the
  same tailnet that answer as a box, pinned to the peer's node), starts pairing, and asks for the
  approval in the Deck, where the passkey is. `vyre link approve` on the server is only for a box
  with no passkey yet.
- **Owner mismatch.** The box serves only `network.owner` (ADR 0002). A Mac signed in to Tailscale
  as someone else gets `not_owner`, and `vyre up` says to sign the Mac in as the box's owner.

**Offline.** The Mac works alone for everything that is the Mac's (SPEC floor rule 9): the
Capsule, local history, the vault's local items. Box features show "your box is not reachable"
with the reason (Mac off the tailnet, box down) and never hang a hook or the Capsule.

### 8. Upgrade, uninstall, backup, move

From the Mac, each command runs over the saved `box.ssh`, so the person still never logs in:

| Command | Does |
|---|---|
| `vyre box update` | `vyre update` on the host (pull, recreate, wait), then updates the Mac's own vyred if the box is newer |
| `vyre box backup [file]` | stops the stack, tars `vyre-home`, `vyre-work` and `tailscale-state` on the host, starts it, and copies one file to the Mac, 0600 |
| `vyre box move user@newhost` | `box add` on the new host up to step 4, stops the old stack, streams the three volumes old → new through the Mac, starts the new one, runs `--uninstall` (not `--purge`) on the old. `tailscale-state` moves too, so the node keeps its name, address and certificate |
| `vyre box remove [--purge]` | `install-box.sh --uninstall [--purge]` on the host; forgets `network.box` |

On the Mac: `npm i -g vyre@latest && vyre up` upgrades (`vyre up` restarts an older vyred);
`vyre down && npm rm -g vyre` removes it and leaves `~/.vyre`. On the server alone, box's
`vyre update` and `install.sh --uninstall` stand as written in docs/INSTALL.md.

## Consequences

- One user-only step is unavoidable in v0.1: turning on HTTPS in the tailnet's admin console.
  The screen makes it one click and a "Check again".
- The address is `vyre.<tailnet>.ts.net`, not `<you>.vyre.run`, until the directory ships. The
  landing page and SPEC section 1 must stop promising the vyre.run name by default.
- Door A needs SSH access with sudo on the server, which a rented VPS gives. A server that asks
  for a sudo password works, because the install runs with `-t`.
- `vyre box add` holds an SSH connection for as long as onboarding takes. That is a foreground
  command the person is watching, so it is outside the idle budgets; nothing polls once it ends.
- The Mac's history does not move to the box. The box reads it through the link while the Mac is
  online.

## Who builds what

| Piece | Owner |
|---|---|
| `vyre box add|update|backup|move|remove`, `vyre up` on the Mac (discover, ask, ending), `vyre up --json`, `vyre capsule install`, the end-to-end harness, this ADR and JOURNEY.md | install |
| `onboard.finish` creating the assistant and greeting; `onboard.you` without `names.check`; ts.net as the default in `onboard.name`, with the HTTPS-off check | box |
| The finish screen (greeting, three ticks, Open Vyre), two QR codes, "Turn on HTTPS", the Mac card, the history wording | deck |
| `link.pair`, `link.find`, `link.status`, `ctx.remote`, offline behaviour | link |
| `vyre.run/box` alias, `Vyre-mac.zip` and `SHA256SUMS`, GETTING-STARTED linking JOURNEY | release |
