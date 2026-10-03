# vault

## 0.3: sealing (branch work/sealing, worktree vyre-vault-03; K3 with platform)

Scope: the sealing process, the inference door with the seal ledger, sealed derivatives, the vault and Drive on the kernel's grants and events (team/0.3/KERNEL-brief.md invariants 4, 5, 6; SPEC-core-contract.md section 8; DESIGN-tasks.md sealed slots). Node now, behind a protocol a Rust process can implement later (kernel/seal/process.js header). reviewer-2 gates every merge.

Done (pushed on work/sealing):
- kernel/seal/normalise.js, ledger.js, classes.js: how a value is recognised in text (case, spacing, separators, full-width, digit words, percent and \u escapes, hex, base64 at three alignments and url alphabet, split across tokens, 75% partial), keyed-hash ledger with derived sessions, class validators and best-effort detectors. Canary-corpus property tests.
- kernel/seal/process.js, store.js, proof.js, wire.js, client.js: the separate sealing process (stdio NDJSON, bare env, own 0700 folder, AES-GCM with ref/space/record/field/class as AAD): put, use (sealed slots merged into a sealed derivative, own verified contact point or document only, else presence), deliver (to an egress sink socket, only a status returns), reveal and derived.read (human only, hardware-signed proof over the exact payload, one use), detect (placeholders, originals bound to the session), save, lookup (rate limited), drop.

- kernel/door/door.js, sinks.json, sinks.test.js: the inference door (declared sinks, bounds, residency, budget, detect then ledger on every message, driver, detect and ledger on the reply, tool results via `result`, `sanitize` for anything persisted), and the CI check that fails when a file outside the registry names a model provider host (retrofit_pending lists today's three, the list only shrinks).
- kernel/seal/placement.js, uses.js: sealed derivatives live only in the sealing folder (0700, outside every sandbox root, checked against box/compose.yml), a project folder gets a reference file; the vault and Drive guard (authorize, run once, one typed event, a refusal looks like absence), the action registry fragment, "Used for Gmail 3 times today" summary, and folds of today's vault_audit rows and agent grants.
- Tests: 39 pass on Node 22 and 24 (kernel/seal and kernel/door): canary corpus and quiet-text properties, human-only reveal, destination rules, delivery to a real unix-socket sink, no plaintext on disk or in any answer, errors carry codes only, line budget (about 600 code lines of 1,500) and the import rule.

K3 gate (reviewer-2, team/0.3/reviews/K3.md at 7ba106454): FIX, items 1 to 5 fixed with regression tests (unique is a person's act and shares the lookup rate limit; vault.use split by kind into fill, totp, read (GET), call (outward), run (admin); dot and encoded-dot paths refused; sessions keyed by (Space, session) and save is a person's; presence enrolment needs the ceremony token, the person's chain, an attestation or an unattested-allowed process, and a proof from a first device for a second). Also item 10 (ref must match the file), 8 (more hosts and SDKs, only the repo's test roots skipped), 11 (recipient_verified, derived outputs expire), 12 (non-ASCII digits, isChain), and 6 (host check, master key mode and owner).

SHIP GATES (record, binding):
1. The file master key is allowed only on a server where the sealing process runs as its own OS user and no agent or Claude Code session shares that uid (hostCheck refuses profile "desktop" and agent uids). A desktop release needs the OS keystore (Keychain with a presence-gated ACL, DPAPI with entropy, the enclave) supplying the master.
2. The door retrofit (sessions and voice behind kernel/door, sinks.json retrofit_pending empty) must land before sealed fields or detection reach assistants. Voice sends audio the ledger cannot scan: the contract must say so as a limit.
Also open: enrolment attestation verifiers (App Attest, Android key attestation, TPM quote, WebAuthn) are plug-ins the native clients supply; where none exists the card says plainly the key is unattested (T6). Reveal requires surface deck, capsule or mobile but a K1 device chain has no via.surface: K1 must set it from the device class, or reveal relies on the proof plus one_person (reconcile before wiring). Ledger scale: a rolling hash would remove the MAX_WINDOWS limit (fails closed today).
Wiring conditions for platform: dest.verified, dest.record and approver_chain come from the kernel (the record and the recorded approval), never from caller input; template body and bindings come from the Template version the approval hashed; door.ledgerKey goes into every reveal; chainCtx only on isChain chains; every persistence of a tool call or result goes through door.sanitize.

Done (R-8, recovery for presence keys, per DESIGN-wink section 2): the process verifies the person's identity chain itself (names/worker/chain.js, vendored from work/spaces at the same path, reviewer-2 to sign off the one import). `presence.sync {person, ops, binds}` pins the chain head (kept in presence.json and in the sealed anchor), drops presence keys whose bound device left the list, and binds keys to device entries (the device's chain key signs bindBytes in wire.js). `presence.recover {person, ops, bind, key_id, spki, signer, token}` gives a person with no key left a new first key from chain evidence only: a listed device vouches for the key, the chain continues the pin (a replayed older list is `chain_stale`, a rewrite `chain_fork`), and a device whose key was revoked is barred. The recovered key is a newcomer: under 24 hours old it removes only newer keys, older keys remove it in one tap (`newcomer`). Works after the key file is lost too (pins live in the anchor). Tests: kernel/seal/recovery.test.js, 58 of 58 in kernel/seal and kernel/door on testbox.
Done (storage pool, first slice, kernel/storage): backends.js (memory, directory, S3 with SigV4; real SeaweedFS integration in s3.integration.js passed on testbox), pool.js (classes, keyed-hash chunks, AES-GCM, healing with grace, drain, forget, usable number, nudges, evict, meters, residency, `copies` for a node that replicates inside itself). 11 tests, all on testbox. R-8 contract posted to windows in team/0.2/CHAT.md.
R-8 gate (reviewer-2, team/0.3/reviews/R8-recovery.md): items 3, 4 and 5 fixed with tests; 1, 2 (chain.js, windows) and 6 (recovery password, Argon2id, windows) are not mine; item 7 (alerts delivery) needs an owner: Wink. kernel/identity/chain.js here is a straight move of windows' file as a placeholder; take windows' version on merge.
Done (4 Oct, reset with wipe; lead's ruling: host CLI only, never a tool or the daemon): `wipeHome` in lib/vault-wipe.js (a lib, so the CLI side imports no core feature) plus `wipeSealDir` in kernel/seal/wipe.js. Takes the home lock (refuses `daemon_running`), destroys key files and the sealing master first, then rows and folders, returns counts. `destroyKeychain` is supplied by the CLI for a keychain keystore. test/vault-wipe.test.js (3) and the wipe test in kernel/seal/seal.test.js, 37 of 37 with boundaries on testbox2. Not covered: the OS keystore master for sealing, disks that remap blocks, the wrapper's confirmation (launch).
Done (4 Oct, Flows "Call a service", core/vault/service.js): connector = an api-credential with `service: { allow, deny }`. `vault.service.catalog` and `vault.service.forward` (internal, kernel:leases or module:leases only); daemon `forwardCredential` calls forward when the kernel gives a connector and no route, and the Flows catalog `connectors` comes from the catalog tool. The Flow gets one refusal (`not_found`) for a missing connector, a plain credential and a path the rules deny. An approved outward call runs once per idem (in memory, an hour) with `released:<approval>` in the audit. A Drive upload or save uses the vault's Drive handle with exactly the paths the kernel already authorized; the per-member Drive door (filesFor) is not available to a Flow call yet. Tests: core/vault/service.test.js, 4 of 4 on testbox2.
Done (4 Oct, seal.detect for assistant): process op `match`, client `detectValue({chain, caller: {module, first_party}, value})`. One candidate, answer `{match}` only; same keyed blind index as `unique` and `lookup`, across the Space's field and class pairs (so it folds case, spacing and separators, not the encoded forms the text ledger catches). The kernel names the module and `first_party` (the process trusts it as it trusts the chain); a chain with a model in it is refused; 4 characters minimum; 5 a minute and 100 a day per (Space, module), 200 a day per Space; the counters are in the process, so a restart resets them. Event `seal.detect {module, count}`, never the candidate or the answer. 28 of 28 in kernel/seal/seal.test.js on testbox2. Platform: register the action and pass `caller` from the reach-module registry.
Done (3 Oct, fourth wave): reviewer-3 S-1 to S-11, the bridged network drive, the encrypted index backup and restore (kernel/storage/indexbackup.js, rollback head = {seq, hash} from `storage.index`; the kernel must record it where the owner's devices hold checkpoints and pass it as `expected` to restoreIndex), V-3, S-2, merged work/v0.3 (125 of 125 on testbox2). Open: a device-to-device Wink transport for the bridge (tailnet), the controller step that encodes sealed SeaweedFS volumes, gateway wiring of Drive, leases and the pool key (platform).
Done (3 Oct, third wave): door.stream (streaming with incremental scan), V-1, V-2, L-5, VyreDrive on the pool (kernel/storage/drive.js), devices.js backendFor for tailnet's attachPool (core/wink/storage/pool.js on work/wink already targets this engine's shape), per-device `classes`. 90 of 90 across kernel/seal, door and storage on testbox2. Open: a network drive that only another device can reach needs a device-to-device backend over Wink; the controller step that encodes sealed SeaweedFS volumes; gateway wiring of Drive and the lease adapters (platform).
Done (3 Oct, second wave): key leases (kernel/seal/leases.js, process ops lease.issue, renew, revoke, reinstate, check; client `lease.*`; `leasedUse` in uses.js; 6 tests) matching the runner's ports `vault.lease`, `vault.renew`, `vault.use`. Pool controller (kernel/storage/controller.js). EC now verified on testbox2 with 4 nodes (SPIKE-storage.md): per-volume ec.encode, 1.46x, one node down reads fine, two down fails; the controller step that encodes sealed volumes is not built.
Doing: nothing in flight. Next: (1) the gateway adapters for the runner: `vault.lease({space, device})` calls `lease.issue` with `allowed` from the two Offer grants, `vault.renew({id})` calls `lease.renew` with `allowed` again, grant removal calls `lease.revoke`, `vault.use({ref, session, route})` is `leasedUse` with `leaseOf(session)` from the runner's session table (platform and runner own that wiring); (2) wire the pool to tailnet's device offers and the owner's grants, credentials for S3 and network drives from the vault; (3) Drive on the pool; (4) EC on a roomier host with 4 or more nodes; (5) the Add storage discovery card (tailnet) and "where things live" data (report() shape).


Needs: windows/platform: the gateway calls `presence.sync` with the person's chain after every enrolment and every chain change, and `presence.recover` after a recovery; person id in the chain must be the identity id (per_...). native: the device signs bindBytes(person, key_id, spki) with its chain key. Storage spike DONE (team/0.3/SPIKE-storage.md): SeaweedFS. native-android run 37129300437 green. R-7 done.

Next: (1) wire into platform's gateway when it lands: chainCtx at the call, Template body and bindings from records for seal.use, presence.enrol from device enrolment, door.ledgerKey into reveal, door.sanitize before any transcript or memory write. (2) The "not sensitive" Ask for a detection (the person marks a match as not a value). (3) The OS keystore as master key custody (fileMaster is the dev path). (4) A real mail egress sink adapter (a small process that sends what the sealing process hands it). (5) Retrofit sessions and voice behind the door (platform).

Needs: platform (gateway hands the process chainCtx, template body and bindings; enrols device keys with presence.enrol; calls door for every model call), tailnet/native (the signer must hash payloads with kernel/seal/wire.js payloadHash and sign proofBytes).

---

Branch: work/vault · Worktree: ../vyre-vault · Milestone: M3 · Wave 1

## Scope

Owns `core/vault/`, `core/cli/commands/vault.js`, `docs/adr/0001-vault-crypto.md`.

Credentials sealed at rest, released one item at a time to a module that holds a grant, never
shown on any screen, log or event (floor rule 8). The case this exists for: a teammate leaves
with an .env file of shared secrets. That must be impossible, and offboarding must be one
action. The goal beyond that is that the user can cancel 1Password (spec section 7.5).

## Done

- ADR 0001: threat model, keystores, per-item keys, caller policy, passes, offboarding.
- Sealing: `crypto.js` (AES-256-GCM, HKDF, scrypt, Ed25519, X25519), `keys.js` (keychain, file,
  passphrase), `store.js` (atomic 0600 item files in a 0700 folder).
- Items, grants, release, audit, pending and approve: `vault.js`, `index.js`.
- Passes: relayed (signed envelopes, host allowlist, replay window, scrubbed replies) and
  sealed (ECIES to the holder's box key); offboarding; `relay.js`.
- Import: `.env`, 1Password CSV, Bitwarden CSV and JSON, Chrome and Safari CSV (`import.js`).
- TOTP (RFC 6238 vectors) and the generator (`totp.js`, `generate.js`).
- CLI: `vyre vault ...` with hidden prompts and `run` with output scrubbing (`cli-io.js`).
- Tests: `core/vault/*.test.js`, `test/vault-cli.test.js` (two real vyred processes, relayed
  pass, revoke, sealed pass, offboard), and the no-leak scan in `core/vault/module.test.js`.

- Autofill: fill listener, pairing, unlock sessions, origin-bound fill, Chrome extension
  (`fill.js`, `modules/vault-extension/`, `docs/adr/0010-vault-autofill.md`).
- Sealed backup and restore (`backup.js`), and 1Password `.1pux` import (`zip.js`).
- Relayed passes bound to the holder's Tailscale login behind `tailscale serve`
  (`vault.relay.identity: "tailscale"`).
- Keychain tests that hold up under parallel runs (`testing.js`): a unique keychain per test,
  taken off the search list under a machine-wide lock, `security` retried when busy.
- Sharing, ADR 0006 decision 5 (`share.js`, `kit.js`, `qr.js`, `tools/share.js`): signed v2
  cards and tickets, pinned people with fingerprints and safety words, agent requests that wait
  for a person, relay hardening (headers only unless `relay.body`, method and path allowlists,
  nonces in vyre.db, https off loopback, audience-bound v2 envelopes, generic 500s, rate-limited
  unknown-pass audit rows, Tailscale identity on loopback only), and the one-time recovery kit
  page with a plain JS QR encoder. Shared vaults and multi-device join are the next wave.
- CLI parity with `op` (ADR 0006 section 6): `get`, `read vault://item/field`, `add`, `edit`,
  `rm`, `inject -i/-o`, `run --env-file`, `share`, `--json` everywhere; the ssh agent
  (`ssh/`) and `git-credential-vyre` (`git.js`), tools in `tools/cli.js`, references in `refs.js`.

- Surfaces (ADR 0006 decisions 2 to 4, section 6): surface sessions (`session.js`), reveal and
  copy with the clipboard helper (`clipboard.js`, `mac/clip.swift`), lock on sleep and screen
  lock (`watch.js`, `mac/watch.swift`), native fill for the Capsule (`native.js`,
  `mac/type.swift`), tools in `tools/surfaces.js`; the extension's inline chooser, keyboard fill,
  one-time codes and save on submit (`fill-save.js`, `modules/vault-extension/inline.js`).

- The Deck's Vault app (`deck/views/vault*.js`, `deck/vault/`), Watchtower (`health.js`), the
  opt-in breach check and `vault.update` (`tools/deck.js`). Click-through against a real vyred:
  `node deck/test/vault-shots.js <out-dir>`.
- Shared vaults, ADR 0006 decision 5 (`shared.js`, `tools/vaults.js`): `shared:<id>` classes
  with a VK wrapped per member (ECIES v2, purpose "vk"), a hash-chained signed membership
  manifest verified on every load, roles, `POST /v1/sync` on the owner's relay listener (pull,
  push with 409 on a stale parent, admin changes), field-level merge or a kept conflict
  revision, owner receipts that peers check against the author's rights, removal with a new VK
  and item keys re-wrapped, rotation flags, and offboarding across shared vaults. Tests:
  `core/vault/shared.test.js`, `test/vault-shared.test.js` (three real vyreds).
- Multi-device (`devices.js`): join code plus fingerprint, approval with presence that seals the
  account keyset to the new device (full: agent key, account record, Secret Key; storage: agent
  key only), item sync between a person's devices over `/v1/sync` with pokes. Shared item
  deletes as signed tombstones. CLI verbs `vaults`, `members`, `move`, `device`. Pull on start,
  on local writes and on pokes, with a ten-minute fallback timer.

## Doing

- 2026-10-01 state: Gate, said intents (send, post, pay, act_out, setting, revoke, use; windows 15 min act_out and 60 min plain; standing permissions; agents field; threads kinds), module-sender recipients (first-party flag), D2 asked handshake, # vault provider, revoke and list scoping, plain-words prompts, Replace the key, key chip hardening with a real-Chrome proof (chip-check.mjs in vault-browser), connect flow left to connectors' readers, and the .env scan (vault.env.scan, vyre vault scan-env) are built and reviewer-2 cleared. Open: step 12 (Capsule calls vault.device.unlock after Touch ID, asked capsule-pro), pairing and fill through the toolbar popup (by-hand check on e2e2's list), and connectors' readers round trip test (theirs). Step 18 docs: connectors put the Entra and Google step lists inside the presets (lib/connector-presets/presets.json guide.steps), so the Deck shows them at connect time; docs/using/connectors.md covers the service account.

- 2026-09-30 (CI): work/vault-next e5974bed is pushed and merged with work/stage-0.2 (connectors now under lib/connectors; presence kept stage's ES256 Capsule pin and my RS256 device keys, new migration widens the alg trigger). vault-mac is green (per-file with alarms; 5 files that hang on macOS without output are reported, not failing: core/vault/module.test.js, surfaces.test.js, tools/cli.test.js, core/cli/commands/home.test.js, threads-sessions.test.js; the same tests pass on Linux). node.yml: waiting on the e5974bed run; earlier failures not mine were shellcheck of install-box.sh (launch) and phone-add push and vyred SIGTERM tests. Chrome launch in browser-check.mjs now spreads CHROME_SAFE; key chip test waits on its worker reply.

- 2026-09-30 (later): reviewer-2 M1 fixed (Gate matches EVERY real destination: email to+cc+bcc via sender `recipients`; http and module senders name none so nothing covers them). Lead rulings built: plain ask single-use (`consume` on vault.said.match, `used` column), standing persists; `agents` field on intents (named agents only, none = any); lineage passed from `threads.lineage {thread}` (OWED by sessions, fails soft to []); pay needs currency on both sides (cap/single-use for pay covered by consume). Person-only Settings tools: gate.said.add / list / revoke; assistant may list and may revoke only with a recorded `revoke` intent naming the id in the same thread lineage. GitHub connector: hub BOUND_ITEMS binds `github-*` items to api.githubcopilot.com (and `google-*` to Google's hosted hosts); `githubServer(login)` gives the mcp.add row. Known flake: core/google module.test.js DWD event order (pre-existing).

- 2026-09-30 relaunch: Gate (asked via said_intents, gate.said.*) is built and on work/vault-next 1b01a6f8. Added intent kind
  "setting" (`to: [key]`) so native-core's C25 check is `vault.said.match {kind:"setting", to:[key], thread}` (internal, module
  callers). CI on 1b01a6f8: node job fails only on shellcheck of scripts/install-box.sh (launch's file, not mine); vault-mac still
  running, so NOT pushing yet. Next: push when vault-mac finishes, send to reviewer-2 and integrator.

- 0.1.1 (lead approved, see message log): 7 of 8 items shipped and green on testbox, each its own
  commit on this branch (boundary fix f3d39f3f..2ee3e337 range - check `git log --oneline` for
  exact shas): kinds.js/ssh-setup.js to lib/ (clears the two frozen boundary edges), scheduled
  breach check, needs-credential reminders, Touch ID nudge, expiring-pass reminder, `vyre up`
  .env nudge, suggest-a-default, passkey coverage in Watchtower. Item #9 (a real Chromium pass
  for the autofill extension, not the vm+stub-chrome extension.test.js uses): wrote
  `modules/vault-extension/testing/browser-check.mjs` (builds the extension, loads it into real
  headless Chromium via CDP, pairs against a real fill listener, fills a real page). NOT YET RUN:
  testbox already had two other Chromium trees running when I checked (ports 9222 and 9450, load
  5.6) and "one Chrome at a time" - waiting on the lead before adding a third.
- The relayed pass between two machines on the tailnet, end to end through the box
  workstream's Docker Compose stack and tailscale sidecar. Waiting on that stack reaching main.
- 2026-09-27: merged main (68463d04) into work/vault-next (51b1d184), then tested 9b (connections)
  on testbox and fixed what broke: `syncVault`/`syncGoogle`/`syncMcp` called `vault.key()`
  unconditionally, creating a key and identity in a fresh home with nothing to sync — the exact
  regression `stop.test.js` exists to catch; now gated on `found.length`. The shared test harness
  (`testing.js` `recorded()`) never wired `ctx.events.on`, so starting the real vault module under
  it crashed once connections.js's `register()` subscribed to sync events; added a fake
  listener/emit pair matching the real `Events` shape. Updated `presence.test.js`'s allowlists for
  `vault.connections.*` (grant and update declare presence; list/get/revoke/sync/register/
  unregister/allowed don't) and two CLI tests whose expected output predated main's newer
  health/history formatting and totp's `next` code. Green sha d6487be9: core/vault (346),
  core/modules, core/cli/commands/vault* + test/vault-* (25), local/voice, core/mcp, core/google,
  test/docs-*, test/hygiene — 534 pass, 0 fail. Sent to integrator and e2e; lands with connectors
  8be461a9.
- 2026-09-27 (later): e2e reviewed a1a4e0b8 and found 1 HIGH + 2 MEDIUM + 2 LOW on connections
  (ADR 0028, 9b): a module could register a connection claiming an item it holds no grant on,
  which made `syncVault`'s "claimed" set delete the real, person-granted vault row for that item
  and take its place — fixed by honouring an items claim only when actually granted to the
  claiming source, and by `list()` never offering a non-ready row in a capability pick. Closed the
  sharper variant too: `register()` now refuses a declared `use.<capability>.tool` that is not the
  caller's own (`<source>.*`), so a module cannot route mail.send at a borrowed account id.
  `vault.connections.revoke` is now scoped to the caller's own surface (chat can't revoke the
  Capsule's); `surfaceOf` now needs a real person session for a tailnet device to count as person
  (ADR 0032, matches settings.isPerson). New test in connections.test.js reproduces e2e's exact
  probe. Fix at 4551a530. Then merged main 476fe5fc (0.1.0-rc.1, incl. e2e's daemon label fix) —
  fixed merge fallout unrelated to the security review (ctx.modules.tools dropped, vault.js's
  VERBS catalog missing agent/codes/connect/connections/emergency/needs/remind/rotate/sweep/uses,
  a 9b CLI test asserting the old vault.connect-backed voice-key flow rc.1's extracted key()
  helper no longer uses). Per the lead: closed the residual gap where a registered row with no
  item claim at all still defaulted to capsule+chat — a module-registered row now starts with no
  surface until a person grants one; vault/google/mcp rows (real connected accounts) keep the
  default. Also ported the unmerged clipboard fix from vault/deck (2c8b1cee, audited by the lead):
  `vault.clipboard.pasteboard` refuses rather than falling back to real pbcopy when the helper is
  down. Green sha f3d39f3f: 558 pass, 0 fail on testbox. Sent to e2e for re-review and to the
  integrator for rc.2.

## Next

1. The Capsule calling `vault.device.unlock` after Touch ID.
2. Grants for relayed items on the holder's side: today any module on the holder's box may call
   `vault.relay` for an item held there.
3. A scan for `.env` files in project folders, offering to import each and delete it.
4. Loading the Chrome extension in a real browser. It is tested only by its manifest and the
   listener's HTTP contract.
5. e2e's LOW from the connections review (f3d39f3f, not blocking): `connections.allowed()` has no
   way to be told a caller carries a person session, so a module acting for the owner's tailnet
   device (e.g. mail on the phone) is always refused rather than allowed - it fails closed today,
   but thread `meta.person` through once a real caller needs it.

## Needs from others

- box: bind `vault.relay.host` to the tailnet address and set `vault.relay.url` to the
  `<you>.vyre.run` form; pass Tailscale identity headers to the listener if it can.
- watchers: use `ctx.vault.fetch(name, { watcher })` from the runtime (manifest
  `needs.vault: ["per-watcher"]`); grants are `vault.grant {name, module: "watchers", watcher}`.
- switchboard: agents' `auth.vault` items (setup token, API key) come through the `agents`
  module's `ctx.vault.fetch(name)` (manifest `needs.vault: ["per-agent"]`), with a grant per item
  to `agents`.
- gate (M9): take over adding credentials at the boundary; the relay listener becomes its client.
- tailnet (ADR 0014 part 7, work/tailnet 0622c88): `vault.relay.grants` is "off" by default. With
  "require", a relayed request also needs the calling peer's whois caps to carry
  `vyre.run/cap/vault` with an entry whose `items` matches the item (exact, or a trailing-*
  prefix) and whose `mode` is the pass's mode or "any". Only `vault.relay.identity: "whois"`
  supplies caps, so "require" under any other identity refuses every relayed request. The check
  runs after every pass check, so a grant only narrows: pass, approval, presence and expiry still
  decide, and nothing in a grant shows a value. The vault reads caps through
  `core/link/transport.js` `parseWhois`/`capValues`, and finds a holder's online node from
  `tailscale status --json` (Peer UserID to User LoginName, shared-in nodes included); tailnet
  keeps both shapes stable. Still to verify on a real tailnet: whether a grant naming another
  tailnet's user reaches their shared-in node's whois caps.

## Changed contracts

- `vault.connections.list` with a `capability` adds `suggest_default: boolean` (0.1.1 #7): true
  the first time that capability has two or more ready connections and no default, then never
  again for that capability (`vault_default_asked`, new table, `DEFAULT_SUGGEST_MIGRATION`).
  `vault.health` adds `touchid: {enrolled, available}` (0.1.1 #4), advisory only. `judge()` adds
  `passkey-available` (0.1.1 #8, `core/vault/passkeys.json`), Watchtower-only like
  `2fa-available` - remind.js's REASONS doesn't list it, so it is never a planner todo.
- `ctx.modules.tools(caller)` (core/modules, kernel): read-only, `structuredClone`d, same shape as
  `GET /v1/tools`. Landed on main via rc.1, not vault-next's own; flagged here per e2e's review
  since it widens a kernel ctx surface. `ctx.modules.status()` is also now `structuredClone`d.
- `ctx.vault.fetch(name, { field?, watcher? })`: the second argument is new and optional.
  `needs.vault` may say "per-agent" as well as "per-watcher".
- `vault.release {name, field?, watcher?}` (internal) returns `{ value }`. It requires an active
  grant for exactly the calling module (and watcher); the manifest declaration alone is not
  enough.
- `vault.put {name, kind?, description?, value? | fields, url?, hosts?, grants?}` returns
  `{name, kind, created, granted?}`. Callers are cli, local and modules; never mcp. A module may
  only create items or replace its own (origin `module:<name>`), and `grants` (module names) is
  for modules only, applied to the item it just put.
- New tools: `vault.backup {file, passphrase}`, `vault.restore {file, passphrase, mode?}`,
  `vault.device.code {name?}` (returns `{code, display, expires, fill}`), `vault.devices`,
  `vault.device.revoke {id}`, `vault.device.unlock {device}`, `vault.unlock-passphrase
  {passphrase}`. All but `vault.devices` and `vault.device.revoke` are cli/local only.
- Fill listener routes under `/v1/fill/`: `pair`, `unlock`, `lock`, `match`, `fill`, `status`
  (see the addendum). Config `vault.fill: {host, port}`.
- Events: `vault.device-paired`, `vault.device-revoked`, `vault.filled`, `vault.restored`.
- Tool definitions may carry `callers: ["cli", "local", "mcp", "module"]`. Other callers get
  `denied`, and `GET /v1/tools` lists only what the requesting caller may use.
- Tool definitions carry `presence: { summary(input), skip? }` on every value-out or
  access-giving vault tool (list in `core/vault/presence.test.js`). `skip` is a proposal to
  security: `({ input, caller }) => boolean`, used for totp sessions and for mcp grant and
  pass.create, which only wait as pending.
- Fill listener: `/pair` needs an extension Origin (403 `origin_required`); a Host outside
  loopback and config `vault.fill.names` gets 421 `host_refused`.
- `vault.generate {name}` from mcp refuses an existing name.
- Crypto v2 (`crypto.js`, `vault.js`): `vault.row(name)` returns undefined for a row whose MAC
  fails; `vault.fields(row)` throws `code: "locked"` for a personal item while the account is
  locked, and refuses a sealed copy whose version or meta disagrees with the row. New:
  `vault.meta(row)`, `vault.open(row)` (`{meta, fields}`), `vault.rowOk(table, row)`,
  `vault.sign(table, id)` (call after any direct write to a MACed table), `vault.grant` is now
  async. `vault.list` adds `personal: "none"|"locked"|"unlocked"` and each item's `vault`.
  `vault.put` takes `apps` and `reprompt` (cards default to true).
- New tools: `vault.account.create {password}` (cli/local, presence; returns `{acct, secretKey,
  moved}` once), `vault.account.unlock {password}` (cli/local, presence), `vault.account.lock`.
  Events `vault.unlocked`, `vault.locked` (`{vault: "personal"}`). Internal `vault.secretKey()`
  for the recovery kit.
- Files in the vault folder: `vaults/agents.json` (agent VK wrapped by the device key),
  `account.json` (KDF params, salt, personal VK wrapped under the AUK), `state.json` (v2 done),
  `secret-key` (file keystores) or a keychain item under account `<acct>:sk`.
- vyred treats an HTTP `x-vyre-caller: module:*` header as `local`.
- Events: `vault.item-added`, `vault.item-changed`, `vault.item-deleted`, `vault.granted`,
  `vault.revoked`, `vault.released` (`{name, module}` or `{name, pass, holder}`),
  `grant.requested`, `pass.requested`, `pass.created`, `pass.revoked`, `pass.accepted`,
  `person.offboarded`. None carries a value.
- Config: `vault.keystore` (`keychain` | `file` | `passphrase`), `vault.keychain` (a keychain
  file), `vault.relay` (`{host, port, url?, identity?: "tailscale"}`), `vault.fill`
  (`{host, port}`), `vault.login` (this person's Tailscale login, put on their card).
- Cards may carry `login`. With `vault.relay.identity: "tailscale"` the relay listener requires
  the `Tailscale-User-Login` header from `tailscale serve`, and a pass made from a card with a
  login answers only that login.
- Sharing (ADR 0006, decision 5):
  - Cards are `vyre-card:v2:` = {acct?, name, sign, box, login?, relay, devices[], sig}, signed
    by the identity sign key. v1 cards are read but block passes until verified.
  - Tickets are `vyre-pass:v2:` with `ownerCard`, `holderSign` and `sig` over
    {tag: "vyre-ticket-v1", ...}. `vyre-pass:v1:` is refused with a readable message.
    `vault_held` is keyed on (owner_sign, id). Held rows from v1 tickets are dropped by the
    migration.
  - Envelopes are v2: `{v: 2, aud, pass, item, request, ts, nonce, sig}`, signed over
    {tag: "vyre-relay-v2", ...}, and `aud` must equal the owner's relay url. v1 envelopes are
    refused, so both sides need this version.
  - `relay.envelope({..., aud})`, `checkEnvelope(env, {holderKey, audience, seen})`,
    `substitute(req, fields, default, {body})`, `encodeCard(card, privDer)`,
    `encodeTicket(ticket, privDer)`; `serve({identity})` refuses "tailscale" off loopback.
  - `vault.pass.create` takes `methods` and `paths` (prefix match). `vault.put` takes
    `relay: {body: true}` (stored in `vault_items.relay`). `vault.pass.accept` from mcp returns
    `{pending}`; `vault.approve` takes its id. `vault.pending` adds `people` and `accepts`.
  - New tools: `vault.people`, `vault.person.add {card, name?}` (mcp: pending),
    `vault.people.verify {name, fingerprint}` (cli/local, presence), `vault.fingerprint {with?}`,
    `vault.kit` (cli/local, presence) returning `{url, expires}`. `vault.identity` adds
    `fingerprint`.
  - Events: `vault.card-changed`, `vault.person-verified`, `vault.kit-printed`,
    `person.requested`, `pass.accept-requested`. `pass.accepted` names the owner as pinned here.
  - For vault-core: `vault.kit` uses `vault.secretKey()` and the card uses `vault.accountId()`
    when the Vault has them. `vault_items.relay` should move into the sealed meta with hosts.
- New tools (tools/cli.js): `vault.item {name}` (all callers) returns `{item}` with `ssh?`,
  `stale?`, `otp`; `vault.resolve {refs, destination?}` returns `{values: {ref: value}}`;
  `vault.render {template, out, force?}` writes `out` itself and returns `{file, refs, items,
  replaced, warnings}`; `vault.edit {name, rename?, description?, url?, fields?, removeFields?,
  addHosts?, removeHosts?}`; `vault.git {action, request}` returns `{response, name?, why?}`;
  `vault.ssh.keys` (all) `{socket, keys}`; `vault.ssh.generate {name, type?, comment?}` (cli,
  local, mcp; new names only) and `vault.ssh.add {name, file}` return `{key}` (public half);
  `vault.ssh.approvals`, `vault.ssh.approve {id}`, `vault.ssh.forget {name?, host?}` (all).
  Resolve, render, edit, git (not erase), ssh.add and ssh.approve declare `presence`.
- `vault.list` takes `kind` and `host`; items gain `ssh: {type, fingerprint, public}` and `stale`.
- Kind `ssh-key` (field `private`): never released, injected, resolved or rendered.
- Config `vault.ssh: { socket: "ssh/agent.sock" }` (relative to, and required under, the Vyre
  home). The module's start handle exposes `ssh.setApprover(fn)` for tests and the presence
  wiring; the default approver refuses and logs "approval needed".
- Event `vault.ssh-approved {name, host, expires}`. Audit actions `resolve`, `render`,
  `git-get`, `git-store`, `git-erase`, `ssh-sign`, `ssh-generate`, `ssh-add`, `ssh-approve`,
  `ssh-forget`. Tables `vault_ssh_keys` and `vault_marks` are created IF NOT EXISTS, outside
  the numbered migrations.
- Surfaces: `vault.session.open {surface: deck|capsule|extension, ttl_s?}` returns
  `{session, expires, surface}`; `vault.session.close {session}` (any caller);
  `vault.session.status {session}` returns `{unlocked, expires, surface}`. `vault.reveal {name,
  field?, session?}` returns `{value, concealAfter: 30}`; `vault.copy` returns `{copied,
  clearsAt, warning?}` and never the value; `vault.fill.native {name, app: {bundle, pid},
  session?}` returns `{filled, via, app}`; `vault.totp` takes `session?` and returns `{code,
  period, remaining}`. All cli/local only except totp (also modules) and session.close. Each
  declares `presence`; reveal, copy and totp `skip` while `vault.sessions.ok(session, name)`.
  `vault.sessions` is on the Vault instance; the last session closing calls
  `vault.account.lock()` if it exists; `vault.lock` also ends sessions and clears the clipboard.
  Reprompt is read from `row.meta.reprompt` (cards default to true until meta lands); native
  fill outside a browser reads `row.meta.apps`.
- Events: `vault.unlocked {surface, sessions}`, `vault.locked {surface, why, ended, sessions}`,
  `vault.revealed {name, field, surface}`, `vault.copied {name, field, surface, clearsAt}`;
  `vault.filled` may carry `app` or `what: "otp"`. Config `vault.lock: {idle, max, onSleep,
  onScreenLock}`; `vault.testHelpers` is honoured only under `node --test`.
- Fill listener: `POST /v1/fill/otp {name, url}` returns `{code, remaining, period}`;
  `POST /v1/fill/save {url, username?, password, name?}` returns `{name, created, updated}`.
  Both need a device and a session. New items get `hosts = [origin]`; updates keep the old
  password in the sealed `history` field (JSON, last 5).
- `module.json` `shows.capsule`: results:vault.list, action:vault.fill.native, action:vault.copy,
  action:vault.totp, action:vault.lock.
- New tools (deck branch): `vault.caps {}` returns `{reveal, breach, host}` (`vault.deck.reveal`,
  default false; `vault.breach`, "off" or "ask", default "off"). `vault.health {}` (all callers,
  MCP too) returns `{items: [{name, kind, reasons, group?}], counts, checked, at}` with reasons
  weak, reused (opaque per-run group ids), old, rotate, 2fa-available, unprotected.
  `vault.breach.check {}` (cli, local, deck; presence) returns `{breached: [names], checked,
  requests, at}`. `vault.update {name, kind?, description?, url?, hosts?, fields?, remove?,
  generate?: {field, length?, symbols?, words?}}` (cli, local, deck; presence) merges with the
  item's fields and returns `{name, kind, created, changed, generated?, bits?}`, never a value.
- The Deck expects (degrading without them): `vault.session.open {surface}` to `{session,
  expires}`, `vault.session.close {session}`, `vault.copy {name, field, session}` to `{copied,
  clearsAt}` (field "totp" copies the current code), `vault.clipboard.clear {}`, `vault.reveal
  {name, field, session}` to `{value}`, `vault.totp {name, session}`, `vault.history {name}` to
  `{versions: [{ver, at, by, fields}], passwords: [{at}]}`, `vault.ssh.generate {name}`. It
  needs the "deck" caller on `vault.totp`, `grant`, `pending`, `approve`, `pass.create` and
  `offboard`, which exclude it today.
- Shared vaults:
  - Items appear locally as `vault_items` rows named `<vault>/<item>` with `vault =
    "shared:<id>"`, so run, inject, grants and the Deck use them unchanged. `vault.open` gets the
    key from `vault.shared.keyFor`, and `vault.at` gets the key version from `vault.shared.kvOf`.
  - `vault.put` with a `<vault>/<item>` name writes to the shared vault and returns
    `{name, vault, rev, merged?}` or `{conflict: true, current}`. `vault.delete` refuses shared
    items (not built yet). `vault.offboard` is async and adds `vaults` to its result.
  - New tools: `vault.vaults.create {name}`, `vault.vaults.list` (mcp visible),
    `vault.vaults.sync {vault?}`, `vault.members.invite {vault, person, role?}` (the person must
    be pinned and verified; returns `vyre-invite:v1:...`), `vault.members.accept {invite}`,
    `vault.members.role`, `vault.members.remove`, `vault.vaults.rotate`, `vault.move {name, to}`.
    Invite, accept, role, remove, rotate and move declare presence.
  - Relay: `serve({onSync})` routes `POST /v1/sync`; `syncEnvelope` and `checkSync` sign and
    check it (tag "vyre-sync-v1", audience, ts, nonce); `callRelay(url, env, {route})`.
    crypto.js gains `rewrapItemKey`.
  - Events: `vault.member-added`, `vault.member-removed`, `vault.key-rotated`,
    `vault.sync-conflicted`. None carries a value.
  - `vault.delete` on a `<vault>/<item>` name writes a signed tombstone; a stale delete is refused.
  - Homes poke members over `/v1/sync` (`op: "poke"`, from the home's key) at the relay address
    on the card pinned for each member; a member pulls on a poke, on start, after its own writes,
    and every ten minutes.
- Devices:
  - New tools: `vault.device.join {role?, approval?}`, `vault.device.approve {code}` (presence),
    `vault.device.list`, `vault.device.sync`. Event `vault.device-joined`.
  - `Vault.replaceAgentKey(raw)` (fresh homes only; re-seals the identity and re-signs MACed
    rows), `Vault.adoptAccount({secretKey, account})`, `Vault.accountRecord()`,
    `Vault.agentKeyBytes()`. `Vault.onEmit` sees every event (sync hooks on item events).
  - `/v1/sync` envelopes whose vault is `device:<group>` go to devices.js. The approving device
    is the home. The newer item version wins; a local edit that loses is kept in
    `vault_group_conflicts` and `vault.sync-conflicted` fires with `vault: "devices"`.
  - Shared vaults are not part of device sync: each device joins those itself.
- Interim presence (`core/vault/prove.js`): `proof.prove({tool, input, caller, summary, env})`
  is the one swappable function; the registry can mark a call as already checked with
  `ctx.presenceEnforced === true` or `presence` in run's second argument. Deck callers pass
  `confirm: true`. Tests set `vault.testHelpers.prove` ("deny" or `{mode, record}`; allow by
  default under node --test). Refusals are Errors with code `presence_required`; the registry
  on this branch reports them as code "failed" with the message.
- `vault.account.unlock {password? , method?: "password"|"touchid"}`, `vault.account.enroll-touchid
  {password}` (presence), `vault.account.status` to `{account, unlocked, touchid, acct?}`.
  `vault.caps` reports `reveal: true`.
- `vault.history {name, field?}` returns `{name, entries: [{version, at, by, changed, current,
  readable}], versions: [{ver, at, by, fields}], passwords: [{at}]}` (the Deck's shape too).
  `vault.revert {name, version}` (cli, local, deck, capsule; presence) returns `{name, version,
  from}`. `vault.reveal` and `vault.copy` take `version`. `vault.versionFields(row, ver)` is the
  method behind them.
- `vault.share.setRelayRules(name, rules)` is async (a new sealed version); `vault.put` takes
  `relay: {body}` directly. `vault.setMeta(name, changes)` re-seals with new sealed columns.
  `vault_ssh_keys` and `vault_marks` rows must be signed with `vault.sign(table, name)` after a
  direct write (tools/cli.js does); `ensureMacColumns(db)` runs after migrate.


## Untested paths (4 Oct 2026, from the full run at bb53cc671 plus the shared-vault fix): what the skips and gaps hide
Full vault, onboard, share, boundaries, seal and storage run on a quiet box: 589 tests, 574 passed, 14 skipped, 1 failed (a test of mine written that hour, fixed after). The 14 skips are all rigs this Linux box does not have, and each one hides a path no test has run on this branch:
- **macOS only (9):** the real Swift helpers build and copy to a private pasteboard (1), the watch and type helpers build with swiftc (1), a build folder others can read is refused (1), the keychain helper's access list, migration of an old item and refusal of a gone build's item (3), the keychain keystore round trip and its restart (2), and the real Touch ID enclave helper (1). Untested on Linux: everything that reaches the Keychain, a Secure Enclave or a Swift helper.
- **macOS helper surfaces (4):** copy never returns the value and lock clears it, `fill.native` hands the login to the helper, a helper's refusal comes back in its own words, and the canary comes back from `vault.reveal` only. These are the vault's native-fill checks.
- **zbarimg (1):** QR codes read in every version and mask need `zbarimg`, which this box lacks.
- **Gaps that are not skips (closed 4 Oct):** I wrote that the shared-vault paths had no rig. That was wrong: `core/vault/shared.test.js` already builds one (`mk` makes a Vault with its own db and keys, registers it as a home in a map so `shared.post` reaches the other Vault in process, and `know` pins and verifies each card). It is two or three members and one home, in a test, with no relay or network. Invite, accept, write, merge, conflict, read-only, remove, offboard, tombstones and the poke were already covered there. What was missing, and is now a test in the same file, is a completed `vault.move` from a member's own vault, a refused move for a read-only member leaving the local item, role changes refused for a non-admin and for the owner, and a rotate that keeps values. Still not covered: two real processes over a real relay (the cross-box run on testbox3 covers that for the storage bridge, not for shared vaults).
