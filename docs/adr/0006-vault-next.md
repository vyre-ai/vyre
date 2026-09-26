# ADR 0006 · The Vault, next: a key hierarchy, presence on every value, and a person's app

Status: proposed, 26 Sep 2026 · Workstream: vault · Extends: ADR 0001 and its autofill addendum ·
Depends on: ADR 0004 (presence) · Spec: sections 2, 5, 7.5 and 11

## Why

ADR 0001 made the Vault safe from a copied disk and from Claude's tools. It did not make it safe
from Claude's shell, and it did not make it something a person would pick over 1Password. Five
reviews ran in parallel: security, sharing, unlock and presence, the Deck app, and the CLI,
Capsule and contract. This ADR reconciles them.

## What the review found

Ranked. File references are to `work/vault` at 9b1a512.

| # | Severity | Finding | Fix (section) |
|---|---|---|---|
| 1 | critical | The keychain item holding the master key was written by `/usr/bin/security`, which puts `security` on its ACL with no prompt. Any process running as the user reads it with `security find-generic-password -s vyre-vault -w` (checked on a throwaway keychain). "Locked" means nothing outside the passphrase keystore. | 1, 2 |
| 2 | critical | Every tool that hands out a value (`vault.inject`, `vault.totp`, `vault.backup` with a passphrase the caller picks, `vault.pass.create` sealed to any card, `vault.restore`) trusts a `cli` or `local` caller, and the caller is a header claim. ADR 0004's floor list names only `put`, `approve`, `unlock` and `offboard`. | 3 |
| 3 | critical | An agent can pair a browser and fill every login with no person: `vault.device.code`, then `/v1/fill/pair` with no `Origin` (allowed), then `vault.device.unlock` ("after Touch ID" is a comment, not a check), then `/v1/fill/fill`. | 3 |
| 4 | high | Pass tickets are not signed. `vault.pass.accept` is open to mcp, and `INSERT OR REPLACE` on `vault_held` lets a forged ticket reuse a known pass id and point a relayed pass at an attacker's relay. | 5 |
| 5 | high | A relayed holder can put `{{vault}}` in a request body and POST it to any path on an allowed host (a public gist on api.github.com), then read it outside the relay. | 5 |
| 6 | high | Metadata in vyre.db (hosts, url, grants, passes, devices) is unauthenticated, and any module can write vyre.db. Hosts decide where the relay sends a value and which page autofill fills. | 1 |
| 7 | medium | `vault.generate {name}` from mcp replaces an existing login's password, which is a put by another name. | 3 |
| 8 | medium | A sealed item's AAD has no version, so an older file dropped back in place opens (rollback). | 1 |
| 9 | medium | `sealFor` salts HKDF with the ephemeral key only: the recipient key is not bound and there is no low-order point check. | 1 |
| 10 | medium | The passphrase keystore takes any passphrase and trusts the scrypt parameters stored beside it. | 1 |
| 11 | medium | The master key lives in heap strings (hex from `security`, `toString("hex")`) and item keys are never zeroed. | 1 |
| 12 | low | Relay: unbounded audit rows from unknown passes, the Tailscale header trusted on a non-loopback bind, replay nonces lost on restart, `e.message` in 500s, `http:` hosts allowed. Fill: no `Host` check (DNS rebinding). | 5 |

Findings 1 to 3 mean a model with a shell can read the whole vault today. They come first.

## Decisions

### 1. Two kinds of vault, and a key hierarchy under them

One master key per home cannot serve both "agents use this while nobody is here" and "only I
can open this". So a home holds vaults of two classes:

- **Agent vault** (`agents`): api-keys, env-sets, secrets, and anything granted to a module.
  vyred opens it unattended, as today. This is what `vault.release`, relayed passes and watchers
  use. On a box it lives on the box.
- **Personal vault** (`personal`): logins, cards, notes and TOTP seeds. It opens only with the
  person's **account unlock key**. vyred holds its key in memory while a surface session is
  unlocked and drops it on lock. A box stores its ciphertext for sync and cannot decrypt it.

Granting a personal item to a module moves it into the agent vault, with presence, and the
summary says so: "github will be usable by mail while you are away".

The hierarchy:

```
Secret Key (128 bit, on devices and the recovery kit) ─┐
password ── Argon2id ─────────────────────────────────┴─► AUK (account unlock key)
Secure Enclave key (Touch ID, per Mac) ────────────────► AUK wrap, for daily unlock
AUK ─► account keyset (Ed25519 sign + X25519 box), sealed
account box key ─► VK (random 256-bit key per vault, versioned kv), wrapped by ECIES v2
device key (keychain or 0600 file) ─► VK of the agent vault only
VK ─► IK (random 256-bit key per item version)
IK ─► item plaintext { meta, fields }
```

- **AUK.** `AUK = HKDF(argon2id(NFKC(password), salt, m = 64 MiB, t = 3, p = 4), acct, "vyre auk v2") XOR HKDF(secretKey, acct, "vyre sk v2")`.
  Node 24.7+ has `crypto.argon2`. Where it is missing, scrypt N = 2^17, and the `kdf` field
  records which ran. Stored parameters are clamped (Argon2id m ≥ 64 MiB and t ≥ 3; scrypt N from
  2^17 to 2^20, r = 8, p from 1 to 4), so a tampered file cannot weaken them. Passwords need 12
  or more characters. With the Secret Key, a stolen disk plus a weak password still costs 2^128.
- **Secret Key.** `V2-<acct 6>-<26 base32 characters>`, with a checksum. It stays on each device
  (keychain, or the 0600 file) and on the printed kit, never in the repo, events or logs.
- **Item seal v2.** Each put makes a new random IK and bumps the item's `ver`. The IK is wrapped
  under the VK with AAD `vyre:ik:v2:<vault>:<kv>:<id>:<ver>`, and the body under the IK with AAD
  `vyre:item:v2:<vault>:<id>:<ver>:<name>`. The body's `meta` holds kind, url, hosts, apps and
  the `reprompt` flag. On open, the vault compares `meta` with the row in vyre.db and refuses a
  mismatch, which ends finding 6 for everything that matters. Rollback (finding 8) fails because
  `ver` is in the AAD and the current `ver` is in an HMACed row.
- **Rows.** Grant, pass, device and item rows carry `mac = HMAC(HKDF(agent VK, "vyre vault meta v1"), canonical(row))`.
  A row whose MAC fails is ignored and audited.
- **ECIES v2.** Salt `epk || recipientPub`, info `"vyre wrap v2:<purpose>"`, an all-zero shared
  secret rejected, and `v` inside the AAD.
- **Memory.** Keys are held as `KeyObject`s (`crypto.createSecretKey`), which `hkdf` and
  `createCipheriv` accept, so raw bytes stay out of the JS heap. Hex from `security` and key files
  is decoded byte by byte into `Buffer.alloc` and zeroed. vyred runs with `--secure-heap`, core
  dumps off (launchd `Core=0`, systemd `LimitCORE=0`). Plaintext field values are still JS strings
  once parsed; Node cannot zero those, and this ADR says so rather than pretending otherwise.
- **The keychain.** The keychain stores a device key that opens the agent vault only, never the
  AUK. The floor denies `security find-generic-password … vyre-vault` (asked of security), and a
  box runs vyred as its own user with the file keystore.
- **Migration.** On first start after upgrade, v1 items are re-sealed in place: `login`, `card`,
  `note` and anything with a TOTP seed go to `personal` once the person sets a password (until
  then they stay in `agents` and Watchtower shows "not yet protected by your password"); the rest
  go to `agents`. v1 files are removed only after every v2 file verifies.

### 2. Unlock, lock and Touch ID

- **Sessions.** A surface (Deck, Capsule, extension) opens a session with a presence proof. vyred
  keeps the personal VK in memory while at least one session is open and zeroes it when the last
  closes. The CLI gets no session: it would have to store a token where a model can read it, so
  every reveal from a terminal is its own proof.
- **Touch ID.** A Secure Enclave P-256 key made with `[.privateKeyUsage, .biometryCurrentSet]`
  (CryptoKit, which works in an ad-hoc `swiftc` build because the key blob lives in our own file,
  not the data-protection keychain). The AUK is wrapped by ECDH with it. Unlock is one dialog:
  the helper evaluates the LAContext with the summary and passes that context to the Secure
  Enclave. A model cannot complete it. Changing fingerprints kills the wrap, so the password path
  is always there. This lands as a verb on presence's hash-checked helper, not a second binary;
  a 30-minute spike confirms it on this Mac before we depend on it.
- **Timers.** `vault.lock: { idle: "10m", max: "12h", onSleep: true, onScreenLock: true }`.
  Sleep and screen lock come from a small Swift watcher in the Aqua session
  (`NSWorkspace.willSleepNotification`, `com.apple.screenIsLocked`), with a wall-clock gap check
  as a fallback. No polling faster than once a minute (principle 8).
- **Re-prompt.** An item with `reprompt: true` needs a fresh proof for every reveal, copy, fill
  and code, session or not. Cards default to it. The flag lives in the sealed `meta`, so a module
  writing vyre.db cannot clear it.

### 3. Presence on every value

Every tool that returns, writes, moves or unlocks a value needs a presence proof (ADR 0004), and
the vault declares it on the tool with a summary that names the item and the destination and
never the value.

| Needs presence | Summary shape |
|---|---|
| `put`, `update`, `delete`, `purge`, `revert` | Replace password of "harlow-drive" |
| `reveal`, `copy`, `totp` (non-module), `resolve`, `render`, `inject` | Put GITHUB_TOKEN into npm's environment |
| `import`, `export`, `backup`, `restore` | Write a sealed backup of 212 items to ~/Backups/vault.vyre |
| `grant`, `approve`, `pass.create`, `pass.accept`, `offboard` | Share "stripe-key" with Dana, relayed, until 1 Oct |
| `device.code`, `device.unlock`, `unlock`, `unlock-passphrase`, `session.open` | Unlock autofill in Chrome for 12 hours |
| `kit`, `emergency.designate`, `vaults.rotate`, `members.*`, `device.approve` | always a fresh proof |

A surface with an open session skips the proof for `reveal`, `copy` and `totp` of non-reprompt
items. Nothing else skips. Taking access away (`revoke`, `pass.revoke`, `device.revoke`, `lock`)
never needs presence. `vault.generate` from mcp may only create a new name (finding 7).

The fill listener refuses `/pair` without an extension `Origin`, checks `Host` against loopback
and the configured name, and `device.unlock` is a presence tool.

Until ADR 0004 merges, the vault declares `presence` on its tools anyway (the registry ignores
unknown fields today), and value-out tools also require an unlocked session, which for the CLI
means the Touch ID wrap of section 2. This is weaker and the changelog says so.

**A spec change this needs.** Floor rule 8 says no value appears on any screen. Section 7.5 says
people see values after unlocking on their own device. The Deck board says nobody can read a
value back. Reveal is the job of a password manager, so rule 8 becomes: *No value from the Vault
appears on any screen, log or event, except to a person who has just proved presence on their
own device, for that value.* The lead and the user decide this. Until they do, the Deck copies
and fills but does not reveal.

### 4. The clipboard

`vault.copy` never returns the value to the caller. On a Mac, vyred hands it on stdin to a Swift
helper that writes the pasteboard with `.currentHostOnly` (no Universal Clipboard) and the
`org.nspasteboard.ConcealedType` and `TransientType` markers (clipboard managers skip it), and
clears it after 90 seconds, or on lock or sleep, only if the pasteboard's `changeCount` has not
moved. The helper also clears when its stdin closes, so a crash still wipes it. Without the
helper: `pbcopy` on stdin, a hash kept, and a compare-then-clear at 90 seconds, with a warning
that clipboard managers will see it. Returns `{ copied, clearsAt }`.

### 5. Sharing

- **Passes stay** for one-off sharing, with fixes: tickets are signed by the owner's key under a
  `vyre-ticket-v1` tag; the holder pins the owner's card, checks the signature and that it is the
  holder, and `vault_held` is keyed on (owner key, pass) and never replaced by a different owner.
  Placeholders go in headers only unless the item sets `relay.body`, with optional method and
  path allowlists. Relay nonces persist for 120 s. `https` is required off loopback. Tailscale
  identity is honoured only on a loopback bind.
- **Cards v2** are signed by the account key and carry devices and the Tailscale login. A
  fingerprint is SHA-256 of `{acct, sign, box}`, shown as five groups of four; safety words are
  computed over both people's fingerprints so both screens match. The first card is pinned
  (TOFU); a changed key blocks new passes and invites until the person verifies with presence.
- **Shared vaults** for teams: a VK per vault wrapped to each member's account box key; a
  membership manifest that is a hash chain, each version signed by an admin of the one before;
  the owner's box holds the canonical ciphertext log and serves `POST /v1/sync` on the relay
  listener with the same signed envelope; items carry `rev` and `parent`, a stale write gets 409
  and the client merges or keeps a `conflict` revision. Roles: owner, admin, member, read-only,
  and use-only (a relayed pass scoped to an agent vault; nothing to rotate when they leave).
  Removing a member rotates the VK, re-wraps item keys (not bodies), and flags every item that
  existed while they held the key. `vault.offboard` covers passes and vaults in one list.
- **Multi-device.** A new device shows a join code and its fingerprint; an existing device
  approves with presence and sends the account keyset sealed to the new device. With no device
  left, the Secret Key and password recover it. The box joins as a storage device for personal
  vaults and a key holder for agent vaults.
- **Recovery kit.** `vault.kit` (fresh presence) serves a one-time loopback page to print: account
  id, Secret Key, fingerprint, the box's address, a QR code (a small encoder in plain JS), a line
  to write the password on, and steps. Never the password, never written to disk.
- **Emergency access.** The owner seals the chosen VKs to a verified contact and stores that
  envelope only on the owner's box. The contact's request notifies every owner device; if nobody
  denies within the wait (default 7 days) the box releases the envelope. Stated limit: a
  compromised box that colludes with the contact skips the wait.

### 6. The person's surfaces

- **Deck.** A full Vault app in `deck/views/vault*.js` and `deck/vault/`, matching the DeckVault
  board and tokens: places in the rail (All, Favorites, kinds, Shared with you, Watchtower,
  Passes, Devices, Archive, Trash), a fuzzy list over names, hosts and field names (never values),
  keyboard (`/`, `j`/`k`, Enter, `c`, `u`, `t`, `e`, `n`, `L`), the item pane with concealed
  fields, copy with a draining 90 s bar, TOTP with a ring, version and password history, the
  generator inline (`generate` travels in the put, so a new value never enters the page), a
  Watchtower computed by vyred (`vault.health`: weak, reused, old, marked for rotation, 2FA
  available from a bundled list), an opt-in breach check shown as the network call it is ("sends
  the first 5 characters of each password's SHA-1 to api.pwnedpasswords.com"), sharing sheets,
  and a phone layout at 390. The Deck proves presence with a passkey. A Deck served by a box can
  reveal agent-vault items only, since the box cannot open personal vaults; in-browser decryption
  with a passkey PRF is later.
- **CLI.** `vyre vault list | get [--reveal|--copy] [--field f] [--otp] | read vault://item/field
  | add | edit | rm | generate | totp | run | inject -i tpl [-o out] | share | pass | offboard |
  ssh | git-credential | kit`, `--json` everywhere with the tool's own `{data}` or `{error}`
  shape, exit 3 for presence refused and 4 for locked. `inject -o` is rendered and written 0600 by
  vyred itself, so values never cross the socket.
- **SSH agent.** vyred serves the ssh-agent protocol on `~/.vyre/ssh/agent.sock` for `ssh-key`
  items (ed25519, rsa-sha2-256/512, ecdsa-p256; SHA-1 refused). The first signature per key and
  destination host key needs Touch ID, then a lease until lock or 8 hours; forwarded requests and
  commit signing need presence every time. Private keys never leave vyred. Vyre prints the
  `IdentityAgent` line and never edits `~/.ssh`.
- **git credential helper.** `git-credential-vyre` matches login items by exact origin and needs
  presence on every `get`, because git prints what it gets; an ambiguous match answers nothing.
  The SSH agent is the recommended path for git.
- **Capsule.** Search (`vault.list`, names only), fill into the front app, copy with auto-clear,
  and TOTP, each behind the Capsule's signed presence after a click. Fill into a native app goes
  through a hash-checked helper that checks the front app and origin and sets the focused field
  by Accessibility; values reach it on stdin. The Capsule itself never receives a value.
- **Extension.** Inline chooser in a closed shadow root that fills only on a trusted click, a
  keyboard fill, one-time-code fill, save on submit and update on change through the fill
  listener, and passkeys in phases (a `passkey` kind signed by vyred; later a credential provider
  in the signed Capsule app).

### 7. Contract fit

Everything is a tool in `module.json`, one definition for MCP, HTTP and CLI. Events carry names,
kinds, destinations and counts, never a value: new ones are `vault.revealed`, `vault.copied`,
`vault.locked`, `vault.unlocked`, `vault.key-rotated`, `vault.member-added`,
`vault.member-removed`, `vault.card-changed`, `vault.sync-conflicted`, `vault.ssh-approved`,
`vault.kit-printed`, `vault.emergency-requested`. `shows.capsule` lists
`results:vault.list`, `action:vault.fill.native`, `action:vault.copy`, `action:vault.totp`,
`action:vault.lock`. Claude over MCP sees list, item, audit, health, generate (new names only),
import (pending), grant and pass.create (pending), revoke, pass.list and pass.revoke, relay,
lock, devices, ssh.keys, and ssh.generate (public half only). It never sees a tool that reveals,
copies, fills, writes a value, unlocks or pairs. `teaches` stays empty: the list is always
current, so Memory gains nothing by copying names.

## Order of work

1. Close findings 1 to 3 and 7: presence on every value tool, the fill listener's pairing hole,
   the keychain denial, `generate` from mcp.
2. Crypto v2: item versions and IKs, ECIES v2, KeyObjects, meta in the seal, MACed rows, signed
   tickets and relay hardening, the agent and personal classes with Argon2id, the Secret Key and
   the Touch ID wrap, and the migration.
3. The person's surfaces: `reveal`, `copy` with the clipboard helper, sessions and auto-lock, the
   CLI verbs, `inject`, the SSH agent, the git helper, the Deck app, Capsule actions, the
   extension's save and inline fill.
4. Sharing: cards v2 and verification, the recovery kit, shared vaults with sync and rotation,
   multi-device join.
5. Later: emergency access, passkeys, attended vaults on the box, passkey-PRF decryption in the
   Deck, CXF import.

## What this does not defend

Code running as the user can still rewrite Vyre, restart vyred and wait for the next unlock. A
program handed a value by `vault run` can print it. A box whose root is taken yields every agent
secret, but no longer a personal login. These are stated in the threat model the way ADR 0001
stated its own.

## Implementation notes (vault/core, 26 Sep 2026)

Where the build differs from the text above, and why:

- **Secret Key format.** `V2-<acct 6>-<26 base32>-<2 base32>`. 26 base32 characters hold the
  128 bits with 2 to spare, which is no room for a checksum, and cutting key bits to make room
  would drop below the 2^128 the AUK argument rests on. So the checksum (10 bits of SHA-256 over
  the account id and key) is its own two-character group.
- **The agent VK** is a random key wrapped by the keystore's key (`vaults/agents.json`), not the
  keystore key itself, so it can rotate later without touching the keychain. The v1 master key
  becomes that device key.
- **Row MACs need the agent VK.** Paths that hand out a value or act on a grant, pass or device
  load it first, so they always check. Names-only paths (`list`, `match`) on a passphrase vault
  that is still locked cannot check and show the rows as they are; nothing there is a value.
- **Upgrade trust.** Rows that predate MACs are signed once, on the first v2 start, and a MACed
  `state.json` then marks the home as v2. After that a v1 item file is refused, not migrated,
  so an old file put back cannot come in through the migration.
- **Crash safety.** Every new sealed version is written as `<id>__next.json`, the row changes in
  a transaction, then the file is renamed over. On start a staged copy that opens against its
  row is promoted, and any other is removed.
- **Presence skip for mcp.** `vault.grant` and `vault.pass.create` from Claude only create
  pending requests, and approving needs presence, so their declarations carry
  `skip: ({ caller }) => caller is mcp`, matching section 7 ("grant and pass.create (pending)").
- **Touch ID spike (26 Sep 2026, this Mac, macOS 26.2).** An ad-hoc `swiftc -O` build of
  `core/vault/mac/enclave.swift` made a `SecureEnclave.P256.KeyAgreement.PrivateKey` with
  `[.privateKeyUsage, .biometryCurrentSet]` and returned its blob and public key: no
  entitlement error, no prompt at creation. So the enclave path is used and the LAContext-gated
  keychain fallback is not needed. `derive` was not run by hand (it prompts); tests use a fake.
  The AUK is wrapped under HKDF(ECDH(enclave key, ephemeral P-256), salt ephPub || sePub,
  "vyre touchid v2:<acct>") in `vault/touchid.json`; the ephemeral private key is dropped at once.
- **Keychain helper (finding 1), 26 Sep 2026.** `core/vault/mac/keychain.swift`, built and
  hash-checked like the other helpers, writes the device key and the Secret Key with SecItemAdd
  and a SecAccess whose trusted-application list is only the helper itself (deprecated
  SecAccessCreate and SecTrustedApplicationCreateFromPath, which still work from an ad-hoc
  build). `security dump-keychain -a` on a temp keychain shows decrypt trusted to the helper
  alone and an empty change_acl list, so `security find-generic-password -w` from any other
  process has to ask the person. An item the old `security -i` path wrote is read once through
  `security`, rewritten through the helper and deleted (tested). Open risk: a new build of the
  helper (any edit to keychain.swift) is a different binary the old items do not trust. The
  store then tries the older builds left in the same private folder and moves the item. That
  path is written but not proved: its test made macOS show a keychain access dialog (a
  SecurityAgent prompt, although the helper turns user interaction off), so the test was
  removed. Until that is understood, keychain.swift should change as rarely as possible.
