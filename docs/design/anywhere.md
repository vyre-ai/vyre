---
title: "Vyre anywhere"
summary: The capability ladder, the role choice, the move-to-server flow, and the Mac server service that implement ADR 0039.
audience: builders, agents
owner: anywhere
status: draft
---

# Vyre anywhere

Implements ADR 0039. Sample world only below (alex, Harlow Legal, Northwind Bakery, juno, kit):
no real names.

## The capability ladder

Nothing about "server or device" is visible until it has to be. Vyre starts with the smallest
shape and grows one rung at a time as the person's setup earns it:

| Rung | What's true | What turns on |
|---|---|---|
| 0. Base | One computer, `machine: "solo"` | Everything except Tailscale, relay pairing, guests |
| 1. Always-on | That computer stays on and reachable (a Mac mini, a box, *vyre server here*) | The `launchd`/service keep-alive, nothing else yet: still `"solo"` until a second device joins |
| 2. A second device | A phone or another Mac is paired | Tailscale or the relay turns on for real (ADR 0002, 0026); role splits into `"server"` + `"device"` |
| 3. Docker | The server has Docker | `computers` (agent computers), `glass` (screen + files for them) |
| 4. A public address | The person wants a webhook or the hosted app | `hooks`, Funnel, `network.origins` |

A person who never leaves rung 0 never sees a Tailscale prompt, a device list, or a "your server
is offline" banner: there is no server distinct from the device. The ladder is the same whether
the always-on computer is alex's Mac mini at rung 1 or a cloud VM someone spun up starting at
rung 2 directly (a cloud server is never `"solo"`; there's no local presence to be solo with).

## The role choice

Three values, one config key (`config.machine`, ADR 0039 section 1):

- **Solo**: "this computer does everything." Default for a fresh single-machine install. Solo is
  never a server (`isServer("solo")` is `false`): no tailnet listener, no public webhooks, no
  owner-claim flow, run on this machine until the person chooses one of the other two.
- **Server**: "this computer is always on for the others." Chosen by running *vyre server here* or by finishing onboarding's "make this the server" path.
- **Device**: "the server is elsewhere; this is one of my devices." Chosen automatically when
  a device successfully connects to an existing server (onboarding's "I have a server, connect
  it"), or when a former Solo/Server machine finishes moving its stuff off (below).

The person is never asked to pick "box" or "device" in the abstract. Onboarding asks the
question the way alex would actually decide it:

> **How will Vyre run?**
> - Just on this computer: *(Solo)*
> - This computer stays on for me, and I'll use other devices too: *(Server)*
> - I already have a Vyre server: *(Device, jumps to "point at a server" below)*

Nothing here mentions Linux, macOS, containers, or Tailscale: those are consequences, not
inputs. If the person picks the middle option on a laptop that sleeps when the lid closes, the
Server flow says so plainly ("Vyre needs this Mac to stay reachable: plug it in and turn off
sleep, or pick a Mac mini or a box instead") rather than silently degrading.

## The eight box-only modules: which ones Solo needs

Reviewer's HOLD (28 Sep) narrowed this to only what Solo's own story actually needs. Default is
NO for each; a module widens to `"local"` only when Solo itself, not a later capability, needs
it running:

| Module | Widen to `"local"`? | Why |
|---|---|---|
| `onboard` | **Yes** (shipped) | Solo has no box to onboard *from*; it must onboard itself. Its wizard tools (you, claude, name, tailscale, history, skip, finish, passkey, link) stay refused on a non-server machine through one shared guard, per reviewer; only `onboard.machine` and (tailnet's) *onboard.join* are exempt. |
| `relay` | **Yes** (tailnet, in progress) | The only way a phone reaches a Solo Mac without Tailscale -- exactly rung 2 of the ladder, needed the moment a device joins. |
| `names` | No | The box's own tailnet listener. Nothing to listen for without Tailscale, which Solo never turns on until it becomes a server. |
| `network` | No | Who besides the owner the tailnet listener serves. Meaningless with no listener. |
| `hooks` | No | Public webhooks over Tailscale Funnel. No Funnel without Tailscale. |
| `releases` (core/apps) | No | Serves the Android APK to a paired phone. By the time a phone exists, Solo has already become a server (section on Solo plus a phone) and gets this for free. |
| `computers` | No | Agent computers. Team-lead's own framing: Docker plus an opt-in, a capability layered ON a server, not part of Solo's base -- and it carries real complexity (VNC passwords, tailnet-per-agent-computer, egress) not worth the surface for a story that doesn't need it. |
| `glass` | No | Screen and files for an agent's computer; same reasoning as `computers`, and already gated on Docker being present. |

## The role-choice tool

Agreed 28 Sep, for launch's onboarding cards and tailnet's *onboard.join*:

- **`onboard.machine`** (new tool, `core/onboard`, HUMAN_ONLY): `{ action: "set", machine: "solo"|"server" }`
  -> `{ machine, service?: { installed: bool, warning?: string } }`. The Deck calls this when
  alex picks "Just on this computer" or "This computer stays on for me": nothing else, no
  polling, purely local. `machine: "server"` on darwin also installs the `launchd`/keep-awake
  service inline (the same code *vyre server here* runs) so the card click is enough; no
  terminal needed. Calling it again with the current value is a no-op on the service side.
  `machine: "device"` is a valid input but never sent by a card directly: it's set by
  *onboard.join*'s `verify` step once a connection to an existing/new server is confirmed
  (`ctx.call("onboard.machine", { action: "set", machine: "device" })`), per ADR 0039 section 5.
- **Solo needs no call at all** until a device later joins (rung 2): matches the capability
  ladder: nothing about the choice exists until it does something.
- **"I already have a server" / "a cloud server"** hand off to tailnet's *onboard.join* (see
  ADR 0039 section 5): `status` to offer Tailscale vs. relay, `tailscale`/`relay` to run the
  connect step, `verify` to confirm reachability and flip `machine` as above.

## How the Deck reaches a Solo Mac, day to day

Raised by e2e, 28 Sep, and revised after reviewer's read of the first draft below (which had a
security mistake reviewer caught: see the correction inline). This goes to reviewer again, in
full, before any code -- team-lead's condition. This is core to "Solo works on day one."

vyred today has three listeners (ADR 0002): the unix socket (same-machine callers with a proven
ancestry: cli, capsule, local), the tailnet listener (the owner's own devices, once Tailscale is
on), and onboarding's loopback HTTP server on `127.0.0.1:7300`, which closes once onboarding
finishes. Solo never turns Tailscale on, so without a fourth answer, nothing would serve a
browser Deck to alex once onboarding closes.

- **The Capsule** (a native Mac app) already talks to vyred over the unix socket directly, the
  same as `cli`, and ADR 0040's split makes this doubly true: it is one of the two clients
  (with the CLI) that may reach vyre-core's own socket straight, with its own ancestry proof.
  Nothing about Solo changes this.
- **The Deck, in a browser**, needs an HTTP surface, because a browser cannot open a unix socket.
  The fix: generalize onboarding's own loopback listener (`core/onboard/loopback.js`) from an
  onboarding-only, close-when-finished server into an always-available one on Solo and Server
  machines with no tailnet address yet, at `127.0.0.1:<port>`.

**The mistake in the first draft:** it called the loopback listener "trusted the way `local` is."
That is wrong, and reviewer's condition corrects it. `local` on the unix socket means the kernel
told vyred which process connected, and its ancestry was walked back to a known caller (ADR
0032). Loopback HTTP carries none of that: any process on the machine, a model's shell included,
can `curl 127.0.0.1:<port>` exactly as a real browser would. So:

- **The `"loopback"` caller label is never person-level, never HUMAN_ONLY, never PERSON_ONLY by
  itself.** It gets exactly what an unauthenticated caller gets: nothing privileged.
- **The session cookie is won through a one-time link**, the same mechanism `onboard.link`
  already uses, minted only by an already-trusted caller (the CLI or the Capsule, over the unix
  socket, or later vyre-core's own socket under ADR 0040) and opened straight into the browser
  (`vyre open`, a new small command). The cookie is unguessable (a long random value, `HttpOnly`,
  `Secure` where the browser allows it on `127.0.0.1`, `SameSite=Strict`) and identifies a
  *browser tab*, never a person.
- **A session cookie alone still isn't presence.** Reads through the loopback listener (static
  Deck assets, listing sessions, non-mutating status) are fine once a plain session exists,
  because a model reading its own transcripts back is not new exposure. Every write or privileged
  call (sending a message that runs an agent, approving a held draft, revealing a vault secret,
  anything HUMAN_ONLY or PERSON_ONLY today) still needs an actual presence proof: a WebAuthn
  passkey signature made in that browser, or a Capsule Touch ID confirm relayed over the socket
  -- checked cryptographically by the presence verifier (under ADR 0040, by vyre-core itself,
  never by the person-side vyred, which shares the model's uid and could otherwise be asked to
  rubber-stamp its own forged proof). This is not a new primitive: it's today's HUMAN_ONLY rule
  (ADR 0004/0032), enforced strictly rather than loosened for loopback's convenience.
- **A Host/Origin allowlist stops DNS rebinding.** The listener checks the `Host` header is
  literally `127.0.0.1:<port>` or `localhost:<port>` (never trusting a name that merely
  *resolves* to `127.0.0.1`, which a page controlled by an attacker's DNS can arrange after the
  browser already loaded it), and checks `Origin` on any request that carries one against the
  same allowlist. A request failing either is refused before it reaches a tool.
- **CSRF protection on every write.** `SameSite=Strict` on the cookie already stops a
  cross-site form post from carrying it; writes additionally require a custom header
  (`x-vyre-caller: loopback` or similar) that only same-origin `fetch` can set, so even a
  same-site navigation link can't trigger one.
- Once a Solo machine becomes a **Server** (pairs a device, or runs *vyre server here*), the
  tailnet listener takes over serving the Deck at the owner's real address, and the loopback
  listener becomes exactly what it is today: an onboarding-only fallback, open just for the
  window before the owner's own device first reaches the tailnet address.

Not yet built. Sending this design to reviewer before writing any of it (generalizing
loopback.js, `vyre open`, the `"loopback"` caller label and its registry rule, the presence-proof
enforcement, the Host/Origin/CSRF checks) -- coordinating with tailnet (ADR 0002's owner) and
with e2e/ADR 0040 (vyre-core owns presence verification once it exists).

## The move-to-server flow

One flow, two entry points, per ADR 0039 section 4:

**Entry A: onboarding, fresh install, "I have a server, connect it."** Nothing to move yet;
the flow's steps 2-4 below are skipped and the new device just pairs.

**Entry B: later, from Settings > Server, "Move to a server."** alex has been running Solo on a
MacBook for three weeks: projects, memory, and a vault full of Northwind Bakery's credentials
all live only there. alex buys a Mac mini and wants it to take over.

1. **Point at a server.**
   - Paste a setup code the new Mac mini shows after running its own onboarding as far as "make
     this the server," or
   - Pick "make this Mac the server" right here: the current machine takes over the server role
     itself (rung 1, no second machine at all: used when someone finally leaves their MacBook
     plugged in and wants it to act as the always-on one).
2. **What moves, and how:**

   | Piece | What happens | Owner |
   |---|---|---|
   | Projects | Copied file-for-file to the destination's project root | federation |
   | Memory (facts, transcript index) | Re-indexed on the destination from the copied transcripts, not re-extracted by a model: a straight copy of the store, revalidated | federation |
   | Vault | Every secret decrypted locally on the source, re-encrypted to the destination's device key, sent over the already-authenticated channel (tailnet or relay), never written to disk unencrypted on either side | federation, vault-next |
   | Sessions | The Claude Code sign-in and any live Vyre-owned session state (ADR 0030) | federation, sessions |

   The source keeps running, fully itself, for the whole copy. Nothing on it changes until
   step 3 confirms.
3. **The destination confirms, then the source flips.** Only after the destination has
   decrypted and verified every piece does the source's `config.machine` change (to `"device"`, or
   it can stay `"solo"` a little longer if alex is only trying this out: the flip is a separate
   confirm, not automatic). The eight box-only modules stop on the source's next `vyred`
   restart. Everything else: Capsule, voice, the local Chat: keeps working on the source,
   now talking to the destination as its server.
4. **Nothing is ever deleted automatically.** The source's pre-move copy sits at
   `~/.vyre/moved-<date>/`, same pattern as `core/projects/move.js`'s existing box-homes
   migration, indefinitely. Settings > Server offers "Free up space on this laptop": it
   previews exactly what would go, by piece (projects, memory, vault, sessions) and with
   counts, and only clears it once alex confirms. There's no timer and no auto-cleanup; a
   device's own data is never removed without the person looking at what's leaving and saying
   yes.

## Failure and undo

- **The copy fails partway** (network drop, destination runs out of disk): the source is
  untouched: it was never flipped: so alex just retries. Settings > Server shows exactly which
  piece failed, not a generic "move failed."
- **The destination looks fine but disagrees with the source** (clock skew made it think it's
  current when a vault write is still mid-flight, say): the flow refuses to flip and surfaces a
  red state rather than silently pick one side.
- **alex changes their mind after flipping:** the same flow run in reverse (destination is now
  the source) moves everything back; since nothing was ever auto-deleted, the pre-move copy is
  usually still sitting there to skip the network copy entirely and just point back at it.
- **The Mac mini playing server dies:** every device stays a device (ADR 0032 keeps them
  separable from "the person"), so nothing about identity breaks. The person's next move is
  Entry A on a new machine, restoring from whichever device still has the most recent vault/
  memory copy: this ADR does not build automatic failover; it builds a move that's cheap and
  safe enough to redo by hand.

## Solo's one-command install

No new script. `docs/get-started/without-docker.md` already covers a Mac running Vyre with no
container: `npm install -g https://vyre.run/box/vyre.tgz` (or `npm install -g vyre` once
published), then `vyre up`. `scripts/install-box.sh` stays exactly what it is: Docker Compose
on Linux: and was never the right script for a laptop.

The gap: `vyre up` bare today assumes `role: local` and goes looking for an existing box before
doing anything else ("finds your box on the tailnet, or asks where Vyre should run"). For a
genuine one-command Solo install with no box anywhere, `vyre up` needs to ask the same
three-choice question as onboarding (or default straight to Solo when nothing answers) instead
of stalling on "where should Vyre run": tracked as anywhere's own follow-up against
`core/cli/commands/up.js`, not a new install path.

## Onboarding and Settings

- **Onboarding** gets one new step (the "How will Vyre run?" question above) replacing the
  implicit OS guess. "I have a server, connect it" hands off to Entry A of the move flow.
  (launch owns the screen; this doc owns the three choices and their copy.)
- **Settings > Server** (new panel, launch + native-core) shows:
  - The current role, in the same plain words as onboarding.
  - "Move to a server" (Solo/Server → Device) or "Move off this server" (Device → Solo, taking
    everything back): both the same flow, run in whichever direction applies.
  - On a Mac acting as Server or Solo: the `launchd`/keep-awake status (section below), and a
    warning if the Mac's own sleep settings would break it.
  - The eight box-only modules' state (on/off), so alex can see at a glance that `glass` is off
    only because there's no Docker, not because something broke.

## The Mac-as-server service

*vyre server here* (ADR 0039 section 3):

1. Sets `config.machine` (asks Solo-vs-Server if ambiguous: a lone Mac with no device ever paired
   defaults to staying Solo unless the person says otherwise).
2. Installs `~/Library/LaunchAgents/com.vyre.vyred.plist`:
   - `RunAtLoad: true`, `KeepAlive: { SuccessfulExit: false }`: restarts on crash, not on a
     clean *vyre stop*.
   - `StandardOutPath`/`StandardErrorPath` into `~/.vyre/logs/`, matching `core/config`'s
     existing log folder.
3. A keep-awake assertion (`caffeinate -s` held by vyred itself while it's the server, or a
   `pmset`-based system assertion) that blocks idle *system* sleep only: display sleep is left
   alone, so the person's own use of the Mac isn't changed.
4. Offers (never forces) a login item so vyred comes back after a full logout/login, since a
   LaunchAgent alone only runs while someone is logged in: the realistic case for a Mac used as
   a home server that stays logged in, not a shared family Mac that logs out each night. FileVault
   machines that require login before disk unlock are told this plainly: full unattended
   restart-after-reboot isn't possible without the person's account unlocking the disk first.
5. `--undo` removes the LaunchAgent and login item, and leaves `config.machine` for the move flow
   to change, not this command.

## Windows later

Out of scope to build here. The seam this design leaves for the `windows` team:

- `core/modules/index.js`'s role→bucket mapping (ADR 0039 section 1) doesn't know or care what
  OS is running `"device"` or `"solo"`: only the `local/*` modules do (`local/screen-mac`,
  `local/hands-mac`, `local/voice`'s mac-only pieces). Windows Solo needs Windows equivalents of
  those, gated the same way, not a change to the role system itself.
- *vyre server here*'s `launchd` half needs a Windows twin (a Windows Service or scheduled task,
  equivalent keep-awake via `SetThreadExecutionState`): same three-step shape (service, keep
  awake, offer at-login start), different OS primitive.
