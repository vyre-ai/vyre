---
title: "ADR 0046: The relay introduces, Tailscale carries"
summary: A server signs in to Tailscale once at setup; Wink pairs every device over the relay; a Touch ID-confirmed pairing mints a short-lived, tagged auth key and sends it over the paired channel so a desktop auto-joins the tailnet, which Vyre then prefers. Phones stay on the relay by default.
audience: builders
owner: tailnet
status: draft
---

# ADR 0046: The relay introduces, Tailscale carries

Status: draft, 28 Sep 2026 · Workstream: tailnet · Builds on ADR 0002 (network and identity),
ADR 0014 (tailnet), ADR 0026 (the relay), ADR 0032 (the person and the device). Renumbered from
this workstream's own "ADR 0038" (team/ADR-NUMBERS.md). Supersedes the relay-first design this
workstream sent for review as "ADR 0038" on 28 Sep, which the user's later, approved direction
below replaces.

## Context

Two designs were considered for what a box's default network looks like without the person doing
any Tailscale setup themselves.

The first, "relay-first everywhere," made the relay the box's only inbound path by default,
Tailscale moved to Advanced. The reviewer's HIGHs and MEDIUMs on that design (owner-arrived never
set with no whois, first-owner pairing becoming the entire root of trust, the web origin serving
the code that holds the keys, relay metadata exposure, a LAN fallback) are carried forward below,
because they apply just as much to the design that replaces it — every one of them is about "how
does a box get its first owner and its later devices without whois," which is unchanged.

The user's decision, approved 28 Sep 2026, is different and simpler: **keep Tailscale as the
transport.** It costs nothing (the Personal plan), and every feature ADR 0014 already built on it
— Taildrive, Taildrop, agent nodes, guests, exit-node egress, Tailscale SSH — keeps working
exactly as today, with no separate relay-only fallback to design and maintain for each of them.
What changes is *who does the Tailscale setup*. Today a person runs through the admin console,
installs the app on every device, signs in on each one, and sometimes enables HTTPS, before they
see anything. That is the actual pain the relay-first design was trying to remove, and it can be
removed without giving up Tailscale: **the relay's job becomes introducing devices to each other
and to the box, and Tailscale's job stays carrying the traffic**, exactly as ADR 0026 already
built the former and ADR 0002/0014 already built the latter.

## Decision

### 1. A server signs in to Tailscale once, at setup

`vyre up --box` on a server (or the Docker Compose install, ADR 0002's amendment) still ends with
a Tailscale sign-in, unchanged from today — the onboarding page's existing Tailscale step, which
already accepts any Tailscale identity provider, GitHub included. Nothing here changes that step;
it is not additional friction, because it happens once, by the person setting the server up, not
by every device that will ever reach it. This ADR does not touch `core/names/tailscale.js`'s
`installCommand`/`upArgs`/`operator` or the onboarding page's tailnet step.

### 2. Wink pairs; the relay never carries anything but the introduction

ADR 0045 (Wink, `relay.pair.ticket`/`resolveTicket`/`pairOffer`) is unchanged and already built.
Every device — phone or desktop — first meets the box this way: scan the Vyre code, resolve and
verify the ticket, confirm the name and fingerprint, pair over the relay's Noise channel. Nothing
in this ADR proposes a second pairing mechanism.

### 3. A confirmed pairing mints a short-lived, tagged Tailscale key and hands it over the same channel

Once a *desktop* Vyre (Mac, Windows, or Linux) finishes pairing over the relay — Touch ID already
confirmed it, per ADR 0045/0026 section 6, no new prompt — the box:

1. Calls the Tailscale API (`https://api.tailscale.com/api/v2/tailnet/-/keys`) with an OAuth
   client credential (below) to create an auth key that is:
   - **single-use** (`reusable: false`);
   - **short-lived** — minutes, not the default 90 days (`expirySeconds`, on the order of 300);
   - **ephemeral where the device's role allows it** (a phone or a temporary machine; not a
     server, which needs to persist as a node);
   - **pre-tagged** with a dedicated tag, `tag:vyre-device` (distinct from `tag:vyre-box` and
     `tag:vyre-agent`, ADR 0014 parts 1 and 9), so the tailnet policy can grant it only what a
     paired device needs and nothing else.
2. Sends the key to the desktop **inside the already-open, already-authenticated Noise channel**
   the pairing just established — never through the relay's HTTP surface, never in a URL, never
   logged. This is the entire reason the key can be short-lived and single-use instead of a
   standing secret: the channel that carries it already proved both ends are who they say they
   are.
3. The desktop runs `tailscale up --authkey=<key> --advertise-tags=tag:vyre-device` (via the same
   `upArgs`/`operator` machinery `core/names/tailscale.js` already has for the box's own
   `vyre up`), **holds the key only in memory for that one call, and never writes it to disk.** A
   failed or aborted `tailscale up` does not retry with the same key — it asks the box to mint a
   fresh one on the next attempt (the old one expires within minutes regardless, per the minting
   scope below).
4. Once the desktop's tailnet node is up, it reads its own new stable ID and sends it back over
   the same relay channel. The box binds that stable ID to the paired device's row
   (`relay_devices`, ADR 0026), the same row `device:<id>` already keys off.
5. Vyre now has two ways to reach this desktop: the relay (`device:<id>`) and the tailnet
   (`tailnet:<owner>`, once the node's whois resolves to the owner's login — see section on
   identity below). **Vyre prefers the tailnet for this device from then on**, using exactly
   `relay/client/paths.js`'s existing direct-then-relay preference (ADR 0026 section 8, ADR 0029)
   — no new preference logic, since that mechanism was already built for "the tailnet name first
   when the device can reach it, then the relay."

### 4. Phones stay on the relay; joining is optional, in Settings

A phone pairs over the relay exactly as ADR 0045 already built, and **stays there** for chat,
approvals and notifications — this is deliberately not automatic for phones. Joining the tailnet
is a one-tap "Faster connection" link in Settings, built the same way as step 3 above (the box
mints a key, sends it over the already-paired channel, the phone runs its own tailnet join through
whatever the platform offers — the Tailscale app via its own auth-key deep link on iOS/Android, or
`tailscale up` if the phone is itself a desktop-class OS). Not part of first pairing, and not
required for anything to work.

### 5. No Tailscale installed on the desktop

If `tailscale up --authkey=...` fails because Tailscale is not installed on the desktop, Vyre:

- offers the platform's install command (`core/names/tailscale.js`'s existing
  `installCommand(platform)`, already returns the right one-liner per OS) with a "Faster
  connection available" note, not a blocking step;
- **falls back to the relay** for that device in the meantime — the pairing itself already
  succeeded over the relay in step 2 above, so there is nothing broken, only a device that stays
  on the slower path until Tailscale is installed (or never is, and that is fine);
- retries the mint-and-join automatically the next time that device's Vyre starts, if Tailscale
  has since appeared.

No device is ever blocked on Tailscale. The relay is always sufficient by itself; Tailscale is
always an upgrade a device can pick up later.

## Identity, once a desktop is on the tailnet

This is the reviewer's HIGH 1 and MEDIUM/HIGH from the shelved relay-first note, carried forward
because auto-joining a *tagged* node raises the same class of problem from a different angle.

**Every reader of `network.owner`/`ownerSeen` (ADR 0002's "Who the owner is," `core/names/
service.js`), and what it means once the relay can introduce an owner without whois ever firing:**

| Reader | Today (whois-only) | With Wink introducing the owner |
|---|---|---|
| `network.owner` (`core/names/service.js:85`, set on tailnet sign-in) | The Tailscale login of whoever signed the box's node in | **Set atomically when the FIRST owner device pairs over the relay** (ADR 0045's first-pairing path, `relay.pair.first`/`onboard`), not only on a Tailscale sign-in. A box that later also gets a Tailscale sign-in (section 1) does not get a *second*, different owner — the sign-in step becomes the server's own tailnet identity, and does not overwrite an owner already set by pairing. |
| `network.ownerSeen` (`core/names/service.js:269`, set once the owner is first seen live) | Set only by the tailnet listener (`core/names/service.js:241`) | **Also set the moment the first owner device completes pairing** (not just a later tailnet sign-in), since that is now a real, presence-backed arrival. Every "no owner yet" branch below is audited against this. |
| `onboard/index.js:103,423,437` — the loopback onboarding link keeps reopening while `!ownerSeen` | Stayed open forever with no tailnet | Closes once `ownerSeen` is set by pairing, same as it would by a tailnet sign-in today. |
| `anywhere`'s `onboard.machine` first-setup presence exemption (`role box && !ownerSeen`, c5d7d318) | Exempted until a tailnet owner signs in | Exempted only until `ownerSeen` — audited to fail closed the instant it is set by a pairing, not left open because "no tailnet sign-in has happened yet." |
| `ownerOverTailnet(caller)` / `ownerDevice(caller)` (`core/modules/index.js`) | `tailnet:<owner>` only, or `device:<id>` (ADR 0026) | **Unchanged.** A desktop that later joins the tailnet (section 3) is *also* reachable as `tailnet:<owner>` once its node's whois resolves to the owner's login (below) — `ownerDevice()` already treats both as equal. No new caller class. |

### A tagged node has no login — whois breaks, and that is fine, because nothing relies on it here

`tailscale whois` on a node signed in with an auth key that carries `--advertise-tags` returns the
**tag**, not a person's login (this is Tailscale's own behavior, not a Vyre choice: a tagged node
has no user behind it). So `ownerOverTailnet()`'s `tailnet:<login>` never fires for a
`tag:vyre-device` node, and it must not be made to — a tag is not a promise about *which* person's
device this is, only that it is *some* device this tailnet's ACLs decided to trust with that tag.

The fix is: **never derive identity from the tag.** The device is already identified, correctly,
by the pairing record from step 3 above (`device:<id>`, bound to a specific `relay_devices` row
that a specific Touch ID confirmed). The tailnet join is purely a *transport* upgrade for that
already-known device, never a second identity check:

- Admission over Tailscale for a `tag:vyre-device` node is **still gated on the stable ID bound at
  step 3**, looked up against `relay_devices`, and admitted as `device:<id>` — the same caller
  label the relay path already uses, not a new `tailnet:tag:vyre-device` label and not
  `tailnet:<owner>`. `core/link/box.js`'s existing exclusion of `tailnet:agent:*` from
  `ownerOverTailnet` is the precedent: a tag on the wire is never treated as the owner.
- The tailnet ACL for `tag:vyre-device` must not let one tagged device reach another's ports: a
  grant shaped `{ src: ["tag:vyre-device"], dst: ["tag:vyre-device"], ... }` would let any paired
  device probe any other paired device's box directly, bypassing the box entirely. The generated
  policy (this workstream's `onboard.tailscale{action:"policy"}`, `core/onboard/index.js`) grants
  `tag:vyre-device` reaching only `tag:vyre-box`, on the box's own port, nothing else — mirroring
  the existing Taildrive/Taildrop grants' own owner-only scoping (fixed 28 Sep, 064fd9cd).
- A server that also has its own real Tailscale login (section 1) keeps working exactly as ADR
  0002 describes today; nothing above changes that path. The tag question only applies to devices
  that joined *through* a Wink pairing.

### The minting credential is a new crown-jewel secret, scoped tightly

The box needs a Tailscale OAuth client that can create auth keys, to mint step 3's key on demand.
This is real, new, sensitive material — creating any key on that tailnet, even a short-lived one,
is a meaningful capability — so:

- it lives in the vault, under a new item (`tailscale-mint-oauth`, mirroring
  `computers.tailnet`'s `tailscale-agent-authkey` naming), never in the container env or a log;
- the OAuth client itself is scoped, in Tailscale's own console, to auth-key creation for
  `tag:vyre-device` only — not full admin, not other tags, following the same "least the feature
  needs" rule ADR 0014 already states for `tag:vyre-egress`'s OAuth client;
- minting a key happens only as a direct consequence of a pairing's own presence proof (the Touch
  ID that already confirmed the device, ADR 0026 section 6) — never on its own trigger, and never
  callable as a bare tool a script could invoke to mint keys for no device in particular.

### Revoke goes both directions

- Removing a paired device (`relay.devices.remove`, ADR 0026) also removes its tailnet node, if it
  has one, through the Tailscale API — a device is either fully gone or not removed at all, never
  half-trusted on one path and revoked on the other.
- Conversely, a node deleted from the tailnet's own admin console (outside Vyre) does not leave a
  `relay_devices` row still marked as reachable over Tailscale — the box notices the node is gone
  (the same "a device went unused too long" pattern ADR 0026 already has for web devices) and
  falls back to treating that device as relay-only until it re-pairs.
- A failed or aborted join (step 3, the desktop never came up on the tailnet) expires its key on
  its own short TTL; nothing further to revoke, since it was never bound to a stable ID.

### Wink's own fixes stand, unchanged

The scan-to-pair mechanism this section leans on (ADR 0045) already has the reviewer's two
blocking fixes from its own review: the ticket-to-key derivations under distinct tags so the relay
never learns the pairing secret (B1), and the MAC-authenticated record so the relay cannot
substitute its own identity (B2), plus the resolve-then-confirm split
(`resolveTicket`/`pairOffer`) so a person sees who they are pairing with before anything pairs.
Nothing in this ADR weakens or bypasses any of that; the auth-key mint in section 3 happens
strictly *after* a pairing those fixes already protect.

## Testing

**Never runs `tailscale up`, mints a real auth key, or touches the real tailnet, anywhere in a
test.** Every test in this area uses the existing fake-tailscale-binary pattern
(`test/helpers.js`, `core/names/tailscale.test.js`) for the desktop side, and a fake HTTP client
for the Tailscale API mint call (matching how `core/computers/tailnet.js`'s tests already fake the
agent-node join). The box's outbound call to `api.tailscale.com` is injected exactly like every
other outbound dependency in this codebase (a `seam`), never the real endpoint, in any test file,
on the Mac or on the test box.

## Consequences

- No paid Tailscale plan is required: the Personal plan already supports OAuth clients, tags and
  auth keys at the scale one owner's devices need.
- Every ADR 0014 Tailscale feature (Taildrive, Taildrop, agent nodes, guests, exit-node egress,
  SSH) keeps working exactly as today, for a box reached this way — nothing about them is relay-
  specific or needs a second implementation, unlike the relay-first design this replaces.
- A new, real secret (the minting OAuth client) exists that did not before; scoped and vaulted per
  above, and it is the one genuinely new attack surface this ADR introduces.
- A device that never installs Tailscale works exactly as well as one that does, just slower on
  the relay path — this is a deliberate design property, not a degraded fallback to fix later.

## Open questions for the reviewer

1. Auth key `expirySeconds`: this note suggests "minutes" (order of 300s) without picking an exact
   number — is there a floor below which `tailscale up` itself becomes flaky (control-plane round
   trip time), or is 300s safe?
2. Whether a *server*'s own desktop-style join (a Linux box acting as `role: local`, joining
   another box's tailnet as a device rather than being the tailnet's own box) needs `ephemeral:
   true` or `false` — this note left it role-dependent without fully specifying the rule.
3. Confirm the tag name `tag:vyre-device` does not collide with anything `anywhere`'s config.role
   work already assumes about tag-derived role detection.
