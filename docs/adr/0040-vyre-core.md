---
title: "ADR 0040: vyre-core, a trusted root split from vyred"
summary: On a Mac, vyred and the person share a uid, so anything a model's shell can write, vyred can be made to trust too. vyre-core is a small, root-owned, always-on daemon that owns every secret, trust anchor and send credential; the rest of vyred stays a person-uid app and asks it for anything privileged.
audience: builders, agents
owner: e2e
status: draft
---

# ADR 0040: vyre-core, a trusted root split from vyred

## Context

The setsid work (docs/work/e2e.md, 28 Sep) closed a real ancestry escape: a model's shell could
`setsid -f` its way past vyred's "is this really the person" check and act as the owner for every
person-only tool. Fixing that surfaced a systemic problem underneath it, which the reviewer named
while signing off the fix rather than blocking on it (work/e2e-setsid b0bcbb6a's review):

**On a Mac, vyred and the person are the same uid, and so is a model's shell.** Everything vyred
trusts -- `~/.vyre/vyre.db` (vault items, grants, presence keys, the Capsule pin, sessions,
history), and vyred's own code on disk -- is writable by that uid. A model that gets a shell at
all (inside a Claude session, which is the ordinary case, not an escape) can, in principle:

- insert its own public key into `presence_keys` and forge a proof for anything (touchid,
  passkey, device or capsule method) without ever touching the socket;
- overwrite a pinned Capsule cdhash, a vault item, a grant, or a send's audit trail directly;
- replace vyred's own installed code with something that skips every check this ADR's sibling
  work just added.

Ancestry checks, presence proofs, exact-path allowlists and one-proof-per-server trust (the
setsid work) all assume the DATA THEY CHECK AGAINST cannot be quietly rewritten by the same uid
that is asking. On a Mac today, that assumption is false. The Linux box does not have this
problem: vyred there already runs as its own `vyre` uid, distinct from the person's login and
from `vyre-agent` (ADR 0032's split), so a model's shell (running as an agent's own uid, or inside
the person's login but never as `vyre`) cannot write vyred's db or code either way.

## Decision

### 1. vyre-core: a second, smaller daemon, root-owned

A new LaunchDaemon, `vyre-core`, runs as its own system account (`_vyre`), started at boot,
independent of any login session. Its code and data live under
`/Library/Application Support/Vyre` (root:wheel, 0700), including a Node runtime it bundles
itself (never the person's own `node`, which they can replace). Nothing under this path is
writable by the person's uid, by a model's shell running as that uid, or by `vyre-agent`.

vyre-core holds no business logic and loads no third-party modules, ever -- it is the smallest
thing that can plausibly stay honest. Its job: hold every secret and trust anchor, verify a
proof against them, and then either release the secret / execute the send, or refuse.

### 2. What moves into vyre-core -- by module, not by tool

Per the lead's rule (28 Sep): the boundary is drawn at the module a secret, trust anchor or send
credential lives in, whole -- reads included. Splitting a store's writes into vyre-core while its
reads stay in person-uid vyred would mean two processes owning one table, which is worse than the
problem this ADR fixes. A module that moves keeps working the same way for every caller (cli,
local, deck, capsule); only where its data physically lives, and which process answers its tool
calls, changes.

**Moves whole:**

| Module | Why | Its own tables (illustrative, not exhaustive) |
|---|---|---|
| `presence` (core/presence) | The trust anchors themselves: every key that can produce a valid proof, and the Capsule's pinned identity. | `presence_keys`, `presence_capsule_pin`, `presence_sessions`, `presence_people`, `presence_codes`, `presence_key_devices` |
| `vault` (core/vault) | The vault store. Every read describes what secrets, grants, devices or history exist; there is no metadata-only read that isn't itself sensitive. | `vault_items`, `vault_grants`, `vault_audit`, `vault_people`, `vault_passes`, `vault_held`, `vault_group*`, `vault_devices`, `vault_sessions`, `vault_meta`, `vault_pairing`, `vault_history`, `vault_shared*`, `vault_relay_nonces`, `vault_ssh_keys`, `vault_marks` |
| the send path in `gate` (core/gate) | `gate.approve` (already HUMAN_ONLY) and `gate.settle` execute a release; `gate.route`/`gate.offer` are delivery mechanics for an approved one. | (gate's own held-item store) |
| pairing in `link` + `relay` (core/link, core/relay) | Establishing trust with a new device or a new relay peer, and the person session that comes out of it: `link.pair`, `link.pair.approve` (already HUMAN_ONLY), `link.pair.request/poll/deny`, `link.signin`, `link.unpair`; `relay.pair.start`, `relay.pair.first`, `relay.devices.trust`, `relay.web.pin`, `relay.web.release`. | link's pairing state, relay's device/key store |
| the tailnet identity in `names` (core/names) | `names.claim`, `names.claim-code`, `names.owner` mint or confirm this box's own identity on the tailnet. | names' claim state |

Each module's OTHER tools (gate.revise/reject/held/get/senders; link.status/find/health/peers/
hello; relay.status/enable/disable/devices.list/rename/remove/path/device.presence;
names.status/check/fallback/connect/release) read or administer without touching a secret or a
trust anchor as far as this pass could tell, and stay reachable from person-uid vyred with today's
caller rules. **Not fully verified**: `gate.held`/`gate.get` return draft CONTENT, which may
itself be sensitive enough to move; `link.call`/`link.remote`/`link.macs*`/`link.serve`/
`link.reply`/`link.events` are the box's own remote-command relay loop and I do not have enough
context on whether a privileged command can ride through them without its own gate --
**anywhere, please weigh in on both before this ships**.

**Not covered by this pass at all** (found while inventorying, not investigated): `core/computers`
(agent sandbox tokens -- COMPUTERD_TOKEN and VNC_PASSWORD were a live HIGH earlier this cycle,
glass-hotfix 57dc12c3; may belong in vyre-core too), `core/spawner` (the privileged spawn socket),
`core/dockerproxy` (the bearer file). A second pass should check these before GA.

### 3. The protocol between vyred and vyre-core

vyred (still a LaunchAgent, still the person's own uid, still where every OTHER module runs) talks
to vyre-core over a second unix socket, root-owned, mode 0600, group-readable by nobody the person
controls. vyre-core authenticates its OWN peer two ways, layered:

- `getpeereid()` (or the macOS equivalent already used for `peerPid`, core/daemon/peer.js) must
  say the connecting uid is vyred's own service account, never the person's login uid. This alone
  rules out a model's shell connecting directly, whatever ancestry it fakes.
- Ancestry (this cycle's setsid work: exePath + the terminal-host allowlist, or the presence-once
  fallback) still applies on TOP of that, for the same reason it applies inside vyred today: uid
  alone says which account, not which process, and vyred itself could in principle be compromised
  and asked to relay something it should refuse.

vyre-core's own tool surface is the module list above, unchanged in name and input shape from
what they are today (`vault.reveal`, `presence.enroll`, `gate.approve`, and so on) -- vyred
forwards a call for one of these tools to vyre-core instead of running it locally, and returns
whatever vyre-core answers. Everything else runs in vyred exactly as it does now. From every
caller's perspective (cli, deck, capsule) nothing changes.

### 4. Touch ID and signatures

Touch ID itself must run in a GUI session (it needs the person's screen and fingerprint reader),
so it stays where it already is: the Capsule app, and `core/link/se`'s helper for the CLI. What
moves is WHO the signature is verified against and where that public key lives. vyre-core holds
the enrolled public keys (`presence_keys`) and does the verifying (`crypto.verify`); it never
does the signing and never sees a private key -- Secure Enclave keys are non-extractable by
design, and the Capsule's own presence key lives in its keychain-ACL'd item, not in vyre-core.

The Capsule's own build identity (this cycle's Capsule pin) is a case of this pattern already:
the Capsule signs with its enrolled `capsule`-kind key (Touch ID, one prompt, at
`vyre capsule install`); vyre-core verifies the signature and the Capsule's OWN read of its
current cdhash (SecCodeCopySelf, the reviewer's condition on 595f1f4c) before trusting the pin,
never a bare claim in the request.

### 5. Install and update, with no Apple Developer ID (a new constraint, 28 Sep)

The user does not want to pay for a Developer ID, so vyre-core cannot be notarized the way a
normal signed daemon would be. Install runs `sudo` once (an admin password, the same trust
moment as any other LaunchDaemon install) to place vyre-core's files and register the
LaunchDaemon. Updates are **self-verified with our own Ed25519 release key**, not Apple's chain:
a release is signed once at build time, and vyre-core (or whatever installs its updates) checks
that signature against a key baked into the installed binary before replacing anything, refusing
an update whose signature does not check out. **anywhere owns the exact mechanics here** (a
signed pkg vs `SMAppService`, where the release key's public half is baked in, how a compromised
running vyre-core would be prevented from installing its own "update") -- this ADR names the
constraint and the primitive (self-verified Ed25519), not the implementation.

### 6. Vault migration

Existing installs have vault data in `~/.vyre/vyre.db` (this cycle) or the login keychain
(earlier versions, per core/link/se's own comments about "Vyre Local" and similar). An upgrade
must move this data into vyre-core's root-owned store, once, before the old copy is trusted for
anything -- **anywhere, please detail**: does the move itself need a presence proof (so a model
mid-migration cannot substitute its own vault before the real one lands), and what happens to a
box that is mid-upgrade when a call comes in.

### 7. Linux is unchanged

The box already runs vyred as its own `vyre` uid (ADR 0032's `vyre-agent` split runs agent
sessions as yet another uid, `vyre-agent`, neither of which is the person's). There is no
same-uid write problem to fix there, so vyre-core does not exist on Linux; vyred keeps its vault,
presence and gate state exactly as it does today.

## Open questions for anywhere (before this is buildable)

1. Install mechanics: signed pkg, `SMAppService`, or something else; where the release key's
   public half is baked in; how the running vyre-core validates an update signed with that key.
2. The vault migration sequence in detail, and its failure modes mid-upgrade.
3. Whether `gate.held`/`gate.get` (draft content) and the box's remote-command relay
   (`link.call`/`link.remote`/`link.macs*`/`link.serve`/`link.reply`/`link.events`) need to move
   too (section 2's "not fully verified" list).
4. Deck's own local path to vyred (a separate question anywhere is already answering) may have
   its own implications here: if Deck's browser session itself ever needs to hold or relay a
   presence proof, which process it talks to changes once vyre-core exists.
