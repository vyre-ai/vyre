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
| `gate` (core/gate), wholesale | `gate.approve` (already HUMAN_ONLY) and `gate.settle` execute a release; `gate.held`/`gate.get` read the draft's content, and `gate.revise`/`gate.reject` change it -- if only approve/settle moved, the thing being approved and the act of approving it would sit on opposite sides of the trust boundary for no reason strong enough to state (anywhere's read, 28 Sep): the SAME same-uid model that might have written a held draft could edit it after approval if held/get stayed in person-uid vyred. `gate.route`/`gate.offer` are delivery mechanics for an approved send. | gate's own held-item store |
| pairing AND the Mac's credentials toward the box, in `link` + `relay` (core/link, core/relay) | Establishing trust with a new device or a new relay peer, and the person session that comes out of it: `link.pair`, `link.pair.approve` (already HUMAN_ONLY), `link.pair.request/poll/deny`, `link.signin`, `link.unpair`; `relay.pair.start`, `relay.pair.first`, `relay.devices.trust`, `relay.web.pin`, `relay.web.release`. Also: any credential the Mac uses to ACT AS the person toward the box -- the device key, sign-in tokens, relay route keys -- moves in too (the reviewer's refinement, 28 Sep): otherwise a same-uid model reads that credential straight off disk and calls the box directly, no pairing needed at all. `link.call`/`link.remote` may stay as proxies in vyred, since vyre-core signs what they carry to the box. | link's pairing state and device credential, relay's device/key store |
| the tailnet identity in `names` (core/names) | `names.claim`, `names.claim-code`, `names.owner` mint or confirm this box's own identity on the tailnet. | names' claim state |

Each module's OTHER tools (gate.senders; link.status/find/health/peers/hello;
relay.status/enable/disable/devices.list/rename/remove/path/device.presence;
names.status/check/fallback/connect/release) read or administer without touching a secret or a
trust anchor as far as this pass could tell, and stay reachable from person-uid vyred with today's
caller rules.

Resolved (anywhere, 28 Sep): `link.call`/`link.remote`/`link.macs*`/`link.serve`/`link.reply`/
`link.events` stay OUT of vyre-core. They are a TRANSPORT (forwarding a tool call to the other
end's own registry.call), not a privilege boundary -- the actual gate is, and stays, at whichever
tool's own callers/presence declaration the call eventually reaches, unchanged by who relayed it
there. Moving the whole relay loop in would mean vyre-core holding real business logic and
reaching into every other module's call surface, directly against section 1's "loads no
third-party modules, ever." Narrower follow-up instead, an audit item not a design change: confirm
link.call's caller-labeling on the receiving end can't be forged to claim a trusted label (cli,
local) it didn't earn -- the same ancestry concern this whole ADR exists to fix for the local
socket, checked once more at the relay boundary.

**Not covered by this pass at all** (found while inventorying, not investigated): `core/computers`
(agent sandbox tokens -- COMPUTERD_TOKEN and VNC_PASSWORD were a live HIGH earlier this cycle,
glass-hotfix 57dc12c3; may belong in vyre-core too), `core/spawner` (the privileged spawn socket),
`core/dockerproxy` (the bearer file). A second pass should check these before GA.

### 3. The protocol between vyred and vyre-core

**Corrected per the reviewer's BLOCKING finding, 28 Sep**: the first draft of this section said
`getpeereid()` "must say the connecting uid is vyred's own service account" -- but vyred HAS the
person's (and a model's) uid, so that check cannot tell vyred apart from a model's shell either,
and if it were the rule, core would end up trusting whatever vyred forwards, which is exactly the
hole this whole ADR exists to close. A 0600 root socket would also simply lock out the CLI and
Capsule, which are person uid too, same as a model.

The actual rule: **core trusts NOTHING vyred says, neither its caller labels nor its ancestry
verdicts.**

- core's socket is reachable by the owner's uid (`getpeereid() == the owner`, which refuses every
  OTHER user on the machine, but not the owner's own model-shared uid -- that boundary is drawn
  by the next two rules, not by uid).
- A privileged call reaches core's socket DIRECTLY from the ORIGINATING client -- the CLI, the
  Capsule, or the Deck's browser -- never relayed through vyred first. core runs `LOCAL_PEERPID`
  plus this cycle's own ancestry work (exePath + the terminal-host allowlist, or the
  presence-once fallback) on ITS OWN peer, the live connection it actually has, the same way
  vyred does today -- it cannot do this for a request vyred forwarded, which would carry vyred's
  own pid, telling core nothing about who really asked.
- OR the call carries a presence proof, which core verifies against its own keys (section 4) --
  the same proof-or-ancestry pattern this cycle's setsid work already established for every other
  person-only action.
- **vyred may proxy READS only, never a privileged write.** A read has nothing to forge (it
  returns data, not permission), so vyred relaying `vault.list` costs nothing; vyred relaying
  `vault.reveal` would let it hand out a secret core never itself verified the request for.

**Stated plainly, since it is easy to miss**: on a Mac, every vyred-side control (the harness
floor, settings, caller labels, the ancestry check inside vyred itself) is **advisory** against a
same-uid model -- useful defense in depth, and still the ONLY enforcement for everything that
stays in vyred, but not what makes a vyre-core-owned action safe. Only core's OWN checks, on its
OWN socket, against its OWN peer, are enforcement for anything this ADR moves into it.

vyre-core's own tool surface is the module list above, unchanged in name and input shape from
what they are today (`vault.reveal`, `presence.enroll`, `gate.approve`, and so on). For a WRITE,
the client (CLI/Capsule/Deck) talks to core directly, as above. For a READ, vyred may still answer
locally by asking core for the data and returning it -- a narrow, read-only proxy, never a source
of truth, useful so the Deck's ordinary "show me the vault list" doesn't need its own separate
connection-and-ancestry-proof plumbing for something that isn't privileged. From every caller's
perspective (cli, deck, capsule) reads look unchanged; a write now proves itself to core, not
to vyred.

### 4. Touch ID and signatures

Touch ID itself must run in a GUI session (it needs the person's screen and fingerprint reader),
so it stays where it already is: the Capsule app, and `core/link/se`'s helper for the CLI. What
moves is WHO the signature is verified against and where that public key lives. vyre-core holds
the enrolled public keys (`presence_keys`) and does the verifying (`crypto.verify`); it never
does the signing and never sees a private key.

**Every presence signing key must be a Secure Enclave key with per-use user presence**
(`kSecAccessControlBiometryCurrentSet` or `.userPresence`), not merely "in the Secure Enclave" --
the distinction matters and was found the hard way (capsule-pro, 28 Sep): an ad-hoc-signed or
"Vyre Local"-signed Capsule's keychain-ACL binds only to a public IDENTIFIER STRING, which any
same-uid ad-hoc binary can read, so ownership of the key alone protects nothing; only a LIVE
finger, required on every signature, does. This applies to both keys this project has today: the
Capsule's own presence key and `core/link/se`'s CLI key.

**Until a Capsule build has a real, stable signing identity, `presence.capsule.pin` refuses it
outright**, with a plain message ("This Capsule build can't prove who it is yet"), rather than
accepting a pin from an ad-hoc-signed build at all. The stable identity itself is owned by
vyre-core, not the person's login keychain, per this ADR's own direction -- it is not solved by
this section, only required by it; the ad-hoc-vs-real check reads the connecting Capsule's own
code signature (`codesign -dvvv` reports `Signature=adhoc` vs a certificate chain), and which
side of the connection carries that check (core, since it is the one enforcing) is an
implementation detail for whoever builds section 3's protocol, not decided here.

The Capsule's own build identity (this cycle's Capsule pin) is a case of the signing pattern
already: the Capsule signs with its enrolled `capsule`-kind key (Touch ID, one prompt, at
`vyre capsule install`); vyre-core verifies the signature and the Capsule's OWN read of its
current cdhash (SecCodeCopySelf, the reviewer's condition on 595f1f4c) before trusting the pin,
never a bare claim in the request. Developer ID signing is optional, for later; a live-biometry
Secure Enclave key is the anchor now.

### 5. Install and update, with no Apple Developer ID

No pkg, signed or otherwise. An unsigned .pkg gets the same Gatekeeper block an unsigned .app
does; notarization is exactly the thing we don't have. Install is a plain script (the same shape
as scripts/install-box.sh already uses on Linux, which asks for sudo to touch Docker and
root-owned paths there): sudo once, interactively, for one admin-password prompt. That prompt is
the trust moment -- there is no weaker version of it that still means anything. The script:

1. Downloads the vyre-core release tarball, checked against SHA256SUMS the same way
   install-box.sh already checks every downloaded file.
2. Under the one sudo: creates the `_vyre` system account (`sysadminctl -addUser` or
   `dscl . -create`, no login shell, no home directory outside its own tree), writes
   `/Library/Application Support/Vyre` (root:wheel or `_vyre:_vyre`, 0700), places vyre-core's
   code, its bundled Node (never the person's own `node` on `$PATH`, which their own uid can
   replace), and `/Library/LaunchDaemons/com.vyre.core.plist` (RunAtLoad,
   `KeepAlive: {SuccessfulExit: false}`, running as `_vyre`).
3. `launchctl bootstrap system /Library/LaunchDaemons/com.vyre.core.plist` starts it
   immediately; no reboot needed, and it now survives one on its own.

`SMAppService` is out, not because it requires a Developer ID outright, but because its approval
UI (System Settings > Login Items, needing the person's explicit "allow") is built around
Apple's own trust chain (a signed, notarized app it can vouch for); without that chain, we would
be asking the person to approve an item macOS itself flags as unverified, which is a worse
experience than one clear sudo prompt during an install the person already started.

**The release key.** A single Ed25519 keypair, generated once, offline. Its public half is a
literal constant baked into vyre-core's own source at build time, compiled in rather than read
from a file on disk -- root can write any file on the machine, so a file would only move the
trust problem, not solve it; a constant means changing the trusted key means shipping and
re-verifying a whole new signed vyre-core, not editing a value in place. Signing a release is a
publishing step the user performs by hand, offline, the private key never touching CI or any
machine vyre-core runs on -- matches the discipline this project already uses elsewhere for
anything that can't be rotated blind.

**The update flow**, vyre-core doing this to itself, on its own schedule (a daily check, or
`vyre update` triggering it early):

1. Fetch the new release's tarball and its detached Ed25519 signature from the GitHub release
   (same as today's CLI update path, core/cli/update/releases.js, minus the OS/notarization
   assumptions that path doesn't have anyway since it already handles an unsigned tarball).
2. Verify the signature against the baked-in public key. Fail closed: a bad or missing signature
   is a refusal, no partial apply, and it says why in its own log, never silently.
3. Only after that: extract to a fresh versioned directory under vyre-core's own tree (never
   overwrite files in place -- the same tmp-then-rename atomicity core/config/index.js's `save()`
   already uses for one file, extended to a whole directory: write the new version beside the
   old, then one atomic rename/symlink flip to make it current), then `launchctl kickstart`
   itself to restart on the new version. A crash between "extracted" and "flipped" leaves the OLD
   version current -- KeepAlive restarts exactly what was running before, never a half-written one.
4. The person-side LaunchAgent (vyred itself) updates through the ordinary npm/tarball path it
   already has, unaffected by any of this -- it holds no secrets vyre-core doesn't already own,
   so a stale or even briefly-compromised vyred is a smaller problem than a compromised
   vyre-core, by design.

What this does and doesn't defend against, stated plainly rather than oversold: this stops the
person's own uid (and anything running as it, model included) from ever getting vyre-core to
execute code THEY wrote, because only a file signed by the offline release key is ever installed,
and nothing on the machine except that offline key can produce a valid signature. It does not
defend against a bug in vyre-core's own update-checking code itself, or a compromised release
key -- those are supply-chain risks this ADR's boundary doesn't reach, same as any software's
update mechanism.

### 6. Vault migration sequence and its failure modes

**When it runs**: inside the same sudo moment as install (section 5, step 2), while the
installer already has root and the person has already proven presence by typing their admin
password -- there is no weaker moment to reuse, so this doesn't need ITS OWN presence proof; the
one that already happened covers it, the same reasoning ADR 0032 already uses for onboarding's
one-time code (a different, but equally load-bearing, one-time trust moment).

**The sequence**:

1. Before touching anything, the installer copies the person-uid's whole `~/.vyre/vyre.db` file
   (not just the vault tables) to a timestamped path under vyre-core's own tree, root-owned,
   unreadable by the person's uid from that moment on -- a safety copy, not the migration itself.
2. It opens that copy and vyre-core's fresh db side by side, and upserts every `vault_*` row (by
   its own id/primary key, never a blind INSERT) from the copy into vyre-core's store, verifying
   each row's encrypted blob still parses as one (catches a half-written row from an earlier
   crash without trusting its contents). Row-by-row, idempotent: re-running this step after a
   crash mid-copy just re-upserts what's already there and adds what's missing, never doubles
   anything.
3. Only once every row the copy has is confirmed present in vyre-core's store does the installer
   write a marker (`vault-migrated: "<timestamp>"` in vyred's own config, mirroring
   core/projects/move.js's `MOVED_RECORD` pattern this project already uses for exactly this kind
   of one-time, must-not-repeat migration) and restart vyred so it starts routing `vault.*` calls
   to vyre-core's socket instead of running the module itself.
4. The original `~/.vyre/vyre.db`'s vault tables are left in place, not deleted -- same
   no-auto-delete rule this project's move-to-server flows already follow. A person who wants
   them gone gets an explicit, previewed "remove the old vault copy" action later, never an
   automatic one.

**Failure modes**:

- Crash mid-copy (between steps 1 and 3). No marker was written, so vyred on next start still
  routes `vault.*` locally, exactly as before the upgrade attempted -- the person's vault keeps
  working from the OLD location. The next install/update run detects the marker's absence and
  re-runs step 2, which is safe to repeat per its idempotency.
- A call arrives while migration is mid-flight. In practice nothing is asking `vault.*` through
  the new path yet in this window; local routing continues to answer against the OLD, still-intact
  db until the marker flips vyred over, and the copy loop reads from a static COPY (step 1), never
  the live db mid-write, so nothing it reads can be torn by a concurrent local write either.
- The marker is written but vyred's restart fails, or it restarts still pointed at the old path.
  Idempotent by construction: a doctor-style check (`vyre doctor`) can say "marker present, but
  vault calls aren't reaching vyre-core" and offer to redo the switch-over step alone, without
  re-copying data that's already there.
- Rollback / a bad update leaves vyre-core unreachable entirely. The untouched original
  `~/.vyre/vyre.db` (step 4) is what a manual "point vyred back at its own vault" recovery path
  reads from -- this needs a real command, not just the data sitting there; flagged as a
  follow-up rather than designed here, since it's a break-glass path, not the common one.

### 7. Linux is unchanged

The box already runs vyred as its own `vyre` uid (ADR 0032's `vyre-agent` split runs agent
sessions as yet another uid, `vyre-agent`, neither of which is the person's). There is no
same-uid write problem to fix there, so vyre-core does not exist on Linux; vyred keeps its vault,
presence and gate state exactly as it does today.

## Open questions -- resolved by anywhere, 28 Sep

1. **Install mechanics**: section 5, above. A plain sudo script (no pkg -- Gatekeeper blocks an
   unsigned one regardless, and notarization is the thing we don't have), an offline Ed25519
   release key baked in as a source constant, and an atomic extract-then-flip update flow.
2. **The vault migration sequence**: section 6, above. Runs inside the install's own sudo moment
   (no separate presence proof needed); copy, row-by-row idempotent upsert, a marker before
   cutover, the original left in place undeleted.
3. **gate.held/get and the relay loop**: resolved into section 2's table directly -- gate moves
   WHOLE (held/get/revise/reject included); the relay/link.call transport stays OUT of core (an
   audit item on caller-label forgery at the relay boundary, not a design change).
4. **Deck's local path, once vyre-core exists**: composes with the loopback design directly, no
   new mechanism needed. Person-side vyred still terminates the loopback HTTP connection and
   proxies READS locally (Deck's static assets, listing sessions); any write reaching a
   presence-gated tool goes through vyred to vyre-core exactly like a CLI or Capsule call would
   (section 3's protocol). The loopback design doesn't need to know vyre-core exists; it just
   asks "the presence module," and which process answers that is section 3's problem, not the
   Deck's.

## Still open

- The relay-boundary caller-label audit named in section 2's resolution above (a verification
  task, not a design question).
- Exactly which side of the connection (the Capsule's own code, or core) carries the
  ad-hoc-vs-real signing-identity check named in section 4 -- an implementation detail for
  whoever builds section 3, not decided here.
- A real `vyre doctor`-style command for the vault-migration failure modes named in section 6
  (a doctor check that can detect and safely redo a stuck migration marker, and a break-glass
  "point vyred back at its own vault" recovery path) -- named, not built.
