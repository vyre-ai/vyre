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
`/Library/Application Support/Vyre`: the code, including a Node runtime it bundles itself
(never the person's own `node`, which they can replace), is root:wheel and not writable by
`_vyre` either, so a bug in core can't rewrite core; the data directory is `_vyre:_vyre` 0700,
readable by nobody else. Nothing under this path is
writable by the person's uid, by a model's shell running as that uid, or by `vyre-agent`.

vyre-core holds no business logic and loads no third-party modules, ever -- it is the smallest
thing that can plausibly stay honest. **core never executes, loads or reads code from any path the
person's uid can write** (their home, `~/.vyre/helpers`, `/Applications`, `$PATH`): only from its
own root-owned code tree. The same holds for the root updater. Its job: hold every secret and trust anchor, verify a
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

**Stays out, decided for now:** `recall`, `memory`, `files`, `sessions` and `projects`. They need
the person's own 0700 home, and a model that can already read that home gains nothing from them.

**`computers`, `spawner` and `dockerproxy`: the rule.** These hold agent sandbox tokens
(COMPUTERD_TOKEN, VNC_PASSWORD), the privileged spawn socket and the Docker bearer file. On a Mac
today none of them runs: agent computers live on the box, where they're already outside the
person's uid. So they stay out of vyre-core for now. The day any of them runs on a Mac
(a Mac server, ADR 0039), its token or socket moves into vyre-core in the same release, by this
section's module rule, and that is a GA blocker for a Mac server (section 7). Until then, a Mac
build refuses to start them.

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
  One limit: vyred may only proxy a read that ANY process running as the owner's uid could ask
  core for directly anyway. A read whose caller rule today is tighter than that (person-only,
  presence) is a privileged call for this section's purposes, and goes to core directly or with
  a proof.
- **A Deck write carries a proof core itself asked for.** The Deck's browser can't open a unix
  socket, so its writes pass through vyred's loopback, and vyred is then only a pipe. The proof
  is one of two things, both issued and checked by core, never by vyred:
  - a passkey assertion over a challenge core issued for that exact request (tool plus input
    hash), single use and short-lived;
  - or a person session core itself minted after such an assertion, which core checks on every
    call.
  vyred's own sessions, cookies and caller labels count for nothing here. A Deck write with no
  core-issued proof is refused by core, whatever vyred says about it. This is the one exception
  to "writes come straight from the originating client": the pipe is allowed because nothing it
  could add or change makes core say yes.

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

**The Capsule's signing identity belongs to vyre-core** (decided 28 Sep). There is no Apple
Developer ID, and a "Vyre Local" certificate in the login keychain is readable by the same uid as
a model, so self-signing with it proves nothing. Instead vyre-core generates its own code-signing
key at install and keeps it in its `_vyre` data directory (never the root-owned code tree, which
holds code only).

**Only a Capsule from a verified release is ever signed.** The signing happens inside the
install and the root apply step (section 5), on the `Capsule.app` taken out of the release
tarball whose signed manifest has just been verified, never on whatever `.app` sits at a
person-writable path such as `/Applications`. The signed `.app` lives in the root-owned code
tree (`/Library/Application Support/Vyre/current/Capsule.app`), and is launched from there;
`/Applications` gets only an alias to it. The keychain ACL on the Capsule's presence key binds to
that signature's designated requirement. A swapped or patched binary, anywhere, fails the DR, so
the keychain refuses it the key and `presence.capsule.pin` refuses its cdhash.

**Until then, `presence.capsule.pin` refuses an ad-hoc or unsigned Capsule outright**, with a
plain message ("This Capsule build can't prove who it is yet"). vyred does this today (8cf64fe9);
once vyre-core exists, core does it, since core is the side enforcing. The check reads the
connecting Capsule's own code signature (`codesign -dvvv` reports `Signature=adhoc` or a
certificate chain) and refuses a cdhash that isn't the connecting binary's.

The Capsule pin itself follows the signing pattern: the Capsule signs with its enrolled
`capsule`-kind key, a P-256 Secure Enclave key (ES256) that asks for Touch ID on every use, not
once at `vyre capsule install`. vyre-core verifies the signature and the Capsule's OWN read of
its current cdhash (SecCodeCopySelf, the reviewer's condition on 595f1f4c) before trusting the
pin, never a bare claim in the request. Developer ID signing is optional, for later.

### 5. Install and update, with no Apple Developer ID

No pkg, signed or otherwise. An unsigned .pkg gets the same Gatekeeper block an unsigned .app
does; notarization is exactly the thing we don't have. Install runs from `vyre up` on the Mac (the
same shape as scripts/install-box.sh on Linux, which asks for sudo to touch Docker and
root-owned paths there): sudo once, interactively, for one admin-password prompt. Updates never
ask for it again. `vyre up`:

1. Downloads the vyre-core release tarball, checks it against SHA256SUMS the same way
   install-box.sh already checks every downloaded file, AND verifies the release's signed
   manifest (version plus tarball hash, as in the update flow below) against the release public
   key the CLI itself ships with. SHA256SUMS comes from the
   same release page as the tarball, so on its own it only catches a broken download.
2. Under the one sudo: creates the `_vyre` system account (`sysadminctl -addUser` or
   `dscl . -create`, no login shell, no home directory outside its own tree), writes
   `/Library/Application Support/Vyre` (code root:wheel, data `_vyre:_vyre` 0700, per section 1), places vyre-core's
   code, its bundled Node (never the person's own `node` on `$PATH`, which their own uid can
   replace), and `/Library/LaunchDaemons/com.vyre.core.plist` (RunAtLoad,
   `KeepAlive: {SuccessfulExit: false}`, running as `_vyre`), plus the root updater's
   `/Library/LaunchDaemons/com.vyre.core.update.plist` (section 5's update flow).
3. `launchctl bootstrap system /Library/LaunchDaemons/com.vyre.core.plist` starts it
   immediately; no reboot needed, and it now survives one on its own.
4. The installer has vyre-core create its Capsule signing key (section 4), then signs the
   `Capsule.app` from the tarball it just verified and places it in the root-owned code tree.

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

1. Fetch the new release's tarball, its manifest and the manifest's detached Ed25519 signature
   from the GitHub release. The manifest names the version and the tarball's SHA-256, so the
   signature covers both
   (same as today's CLI update path, core/cli/update/releases.js, minus the OS/notarization
   assumptions that path doesn't have anyway since it already handles an unsigned tarball).
2. Verify the manifest's signature against the baked-in public key, then the tarball's hash
   against the manifest. **Anti-rollback:** refuse any version at or below the one running, so an
   old, validly signed release with a known bug can't be replayed. core keeps the highest version
   it has ever run, and the updater keeps its own copy of that floor under the root-owned code
   tree, where `_vyre` can't lower it. Fail
   closed: a bad or missing signature, a hash mismatch or an old version is a refusal, no partial
   apply, and it says why in its own log, never silently.
3. Only after that, the apply step runs. vyre-core can't write its own code (section 1), so a
   second LaunchDaemon, `com.vyre.core.update`, runs as root and does only this: it re-verifies
   the manifest's signature, the tarball's hash and the version floor itself (it never trusts
   core's verdict), then extracts it to a fresh versioned directory under the root-owned code
   tree. Extraction refuses the whole tarball if any entry has an absolute path, a `..`
   component, or is a symlink, a hardlink or a device file, and it never keeps the tarball's
   owners or modes (everything is root:wheel, no setuid). Before the flip it signs the new
   `Capsule.app` with core's signing key (section 4). It writes (never
   overwrite files in place -- the same tmp-then-rename atomicity core/config/index.js's `save()`
   already uses for one file, extended to a whole directory: write the new version beside the
   old, then one atomic rename/symlink flip to make it current), then `launchctl kickstart`s
   vyre-core on the new version. The updater has no network access and no socket of its own; it
   starts when a file lands in the staging directory `_vyre` owns (a launchd WatchPaths job). A crash between "extracted" and "flipped" leaves the OLD
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

### 5a. First-install trust and the limits, as built (anywhere, 30 Sep, after reviewer-2's round)

- **The first install is verified before sudo, against a key the script carries.** The person already
  trusts the install script (it is the curl|sh line). It embeds the release public key and, before any
  password prompt, checks SHA256SUMS.sig (the one signature Linux and Mac share, over the exact bytes of SHA256SUMS, which lists manifest.json and vyre.tgz) with the pinned, sha256-checked Node and a check written in the
  script, then checks the manifest and the tarball against its lines; the version and the anti-rollback floor stay in manifest.json. A key inside the tarball proves nothing
  on a first install, since the tarball controls it.
- **Root runs nothing the person can write.** The sudo step is one fixed `sh -c` literal in the script.
  It copies the release files and the Node tarball into a fresh root-owned 0700 folder, hashes the
  root-owned copies against the two expected sums, extracts with /usr/bin/tar, and runs the installer
  from that tree with that node. The installer also refuses a node whose bytes do not match the hash
  it was given, because the update daemon runs that binary as root for the life of the install.
- **The honest limit.** The script and the release files are both served from vyre.run. Someone who
  controls that whole origin can serve a script with their own key; the offline key then protects
  updates, not the first install.
- **The placeholder key cannot ship.** scripts/check-release-key.mjs stops the site build and
  scripts/release.sh while release.js still carries the placeholder, or while the script's key differs
  from release.js's. Only a dry run may pass it (VYRE_ALLOW_PLACEHOLDER_KEY=1), and a publishing run
  cannot.
- **The update daemon never recurses in a folder _vyre owns.** It unlinks the three known staged names
  (a link is removed, never followed), opens each with O_NOFOLLOW, and ignores everything else.
- **keys.* is not model-proof, and does not claim to be.** core cannot tell vyred (a launchd job) from a
  process that detached itself to look like one, because both have no Claude ancestor and a launchd
  parent. keys.* therefore protects the private halves from being read or copied, and refuses a model
  that stays in its session; it does not stop a model that deliberately daemonizes from asking core for
  a DH or a signature as the owner. Every such use is counted, logged and emitted as a `keys.used` event
  vyred shows, so misuse is visible. The real fix is identifying the peer by code signature (the audit
  token and SecCode) once vyred and the Capsule are signed.

### 6. Vault migration sequence and its failure modes

**The rule (reviewer, 28 Sep): only item secrets move; every piece of trust state is made
again.** The old `~/.vyre/vyre.db` was writable by a model, so any row in it may be one a model
planted: a grant to itself, a device, a session, a pairing, a person. The admin password doesn't
settle that. It proves someone could run sudo, not which rows are real, and it shows the person
nothing.

- **Moves, after the person confirms a list:** vault item secrets, and nothing else.
- **Made again in core, never copied:** grants, devices, pairing, people, and every presence key
  and the Capsule pin. The person re-enrolls (Touch ID in the Capsule, the CLI's Secure Enclave
  key, passkeys, phones), re-pairs phones and grants again. Old `presence_*` and `vault_*` trust
  rows are never read by core.
- **Dropped:** sessions, pairing codes, relay nonces. The person signs in again.

**The vault key never moves either.** Today the items are encrypted under a key in the person's
LOGIN keychain (core/vault/vault.js's keystore, through the helper under `~/.vyre/helpers`). A
model can reach both; `_vyre` can reach neither, and must not try: running that helper would be
core executing person-writable code (section 1). So the old key is only ever used person-side.
core mints its own vault key in its `_vyre` data directory and re-encrypts every imported secret
under it. It never stores an old blob as it is, and nothing core stores is readable with the old
key.

**The sequence**, after install and re-enrollment:

1. The installer copies the person-uid's whole `~/.vyre/vyre.db` file to a timestamped path
   under vyre-core's data directory, readable by `_vyre` only. This is a safety copy, not the
   migration itself.
2. core shows the person how many items there are and each item's name, and nothing else from
   the old db, plus one line: "the old copy will be erased once these are moved", with the
   erase ticked by default. The person unticks any item they don't recognise (or the erase) and
   confirms with a presence proof from a key enrolled AFTER install (Touch ID on the new Capsule
   key, or Approve on a re-paired phone). core records the approval under an id.
3. The decrypt runs PERSON-side: the Capsule (or `vyre` in the terminal), as the person, reads
   each confirmed item with the old key and streams its plaintext to core's socket, bound to the
   approval id. core accepts only items on that approved list, only for that id, and only once.
   It re-encrypts each item with its own key and upserts it by item id; an item that doesn't
   decrypt is reported by name, not stored. Row by row and idempotent: re-running after a crash
   re-upserts what's there and adds what's missing, never doubles anything.
4. Only once every confirmed item is present does core write its migration marker, in core's
   OWN data directory, never vyred's config. A model can delete anything in vyred's config and
   would then send vyred back to the old vault. From the moment vyre-core is installed, vyred
   sends `vault.*` to core whatever its own config says: at start it asks core "do you own the
   vault?", and core's answer is the truth. vyred's own vault store refuses every write once
   vyre-core is installed, so an item saved after cutover can never land in the old store. The
   only way back to the old local vault is the break-glass command below.
5. If the person left the erase ticked in step 2 (the default), the same approved step then
   erases the old vault tables and the old key's keychain items. This runs person-side too,
   since only the person's uid can reach their keychain, and the erase is shown as done by name.
   It is the person's own previewed choice in step 2, never an automatic deletion, so the
   move-to-server flows' no-auto-delete rule holds. Unticked, the Capsule keeps offering it.

**The residual, stated plainly:** any secret that sat in the old store could already have been
read by a model, since it was readable by the person's uid. vyre-core protects secrets from
install on; it can't take back what was already readable. And if the person unticks the erase,
the old copy stays readable to a model until they erase it. The last screen says so in one line,
and lists the moved items to rotate first: cloud and API keys, SSH keys, email and bank or
payment logins, and the Mac's credentials toward its box.

**Failure modes**:

- Crash between steps 1 and 4. core has no marker, so it resumes at step 2 (the list is shown
  again) on its next start. vyred already routes to core, and core answers `vault.*` with "your
  vault is still moving; finish it in the Capsule" until the marker exists.
- The person-side read in step 3 can't be torn by a concurrent write: vyred's old vault store
  refuses writes from the moment vyre-core is installed (step 4), so the old store no longer
  changes.
- vyred restarts still pointed at the old path. `vyre doctor` says "vyre-core is installed but
  vault calls aren't reaching it" and offers to redo the switch-over alone.
- vyre-core unreachable after a bad update. A break-glass `vyre vault fallback` points vyred at
  the old vault only if the person hasn't wiped it. core can't approve anything while it's down,
  so this asks for the admin password (sudo), which a model can't type. It is named here, not
  built.

### 7. What waits for vyre-core

vyre-core blocks Mac general availability. Two things wait with it (reviewer, 28 Sep):

- A phone joining a Solo Mac. Pairing and relay keys are exactly what a same-uid model could
  forge today, so a Solo Mac doesn't take new phones until core holds those keys.
- Relay on a Mac. It ships off by default, can be switched on only with a presence proof, and
  no release turns it on until vyre-core holds the relay keys.

**A Mac as the server (ADR 0039).** ADR 0039 lets a Mac be `"server"` or `"solo"`, running
`names`, `relay`, `onboard` and, with Docker, `computers`, all as the person's uid. So "the
server" is not always a Linux box with its own `vyre` uid. On a Mac server, vyre-core must also
hold, before that machine role ships:

- the tailnet identity and owner claim (`names`) and the relay and pairing keys, as section 2
  already says;
- the agent computers' tokens (COMPUTERD_TOKEN, VNC_PASSWORD), the spawner's privileged socket
  and the Docker proxy's bearer file. These are **GA blockers for a Mac server**: a Mac server
  release with `computers`, `spawner` or `dockerproxy` running as the person's uid doesn't ship.
  Until core holds them, a Mac server runs without agent computers, as ADR 0039 already allows
  for a Mac with no Docker.

### 8. Linux is unchanged

A Linux box already runs vyred as its own `vyre` uid (ADR 0032's `vyre-agent` split runs agent
sessions as yet another uid, `vyre-agent`, neither of which is the person's). There is no
same-uid write problem to fix there, so vyre-core does not exist on Linux; vyred keeps its vault,
presence and gate state exactly as it does today.

## Open questions -- resolved by anywhere, 28 Sep

1. **Install mechanics**: section 5, above. A plain sudo script (no pkg -- Gatekeeper blocks an
   unsigned one regardless, and notarization is the thing we don't have), an offline Ed25519
   release key baked in as a source constant, and an atomic extract-then-flip update flow.
2. **The vault migration sequence**: section 6, above. Only item secrets move, from a names
   list the person confirms with a post-install proof, decrypted person-side and re-encrypted under core's own key; all trust state is made again;
   core owns the marker; the old copy is erased in the same confirmed step (ticked by default),
   and the residual is named, with what to rotate first.
3. **gate.held/get and the relay loop**: resolved into section 2's table directly -- gate moves
   WHOLE (held/get/revise/reject included); the relay/link.call transport stays OUT of core (an
   audit item on caller-label forgery at the relay boundary, not a design change).
4. **Deck's local path, once vyre-core exists**: composes with the loopback design directly, no
   new mechanism needed. Person-side vyred still terminates the loopback HTTP connection and
   proxies READS locally (Deck's static assets, listing sessions); any write reaching a
   vyre-core tool passes through vyred as a pipe only and carries a presence proof core verifies
   (section 3's Deck rule). The loopback design doesn't need to know vyre-core exists; it just
   asks "the presence module," and which process answers that is section 3's problem, not the
   Deck's.

## Still open

- The relay-boundary caller-label audit named in section 2's resolution above (a verification
  task, not a design question).
- A real `vyre doctor`-style command for the vault-migration failure modes named in section 6
  (a doctor check that can detect and safely redo a stuck migration marker, and a break-glass
  "point vyred back at its own vault" recovery path) -- named, not built.
