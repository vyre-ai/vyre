# vault

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

- 2026-10-02 (reviewer-2 on native apps, cleared d710d3011 with one MEDIUM and LOWs, all taken): the privileged steps now re-check what they sign from workflow-supplied values (Android: aapt2 badging package, versionName and derived versionCode, plus check-permissions on the exact APK; iOS: bundle id, version, build number and usage keys from the archive's Info.plists before the key is written); no fallback to this commit's pin once any recent release published an APK; the iOS tarball extracts into a subfolder and the key is written after the checks; record_cert no longer lists work/stage-0.2. Open: use the lowest App Store Connect role (not Admin) and confirm on the first dry export.

- 2026-10-02 (native apps, branch work/022-native-android): Android is a signed APK for vyre.run and the GitHub release, no Play, no AAB; iOS goes to TestFlight. Built, not yet run against a real key or account (none exists): (1) #69: `android.blockedPermissions` in apps/app/app.json (RECORD_AUDIO, the two storage permissions, SYSTEM_ALERT_WINDOW), the line also gone from the paused apps/android manifest; the merged manifest of the built APK is read by `scripts/native/check-permissions.mjs` against `docs/native/permissions.json`. (2) `native-android.yml` is reusable: build (no secret, `npm ci --ignore-scripts`, unsigned APK, versionCode from the release version), dry-sign (throwaway key, proves the pin refuses PENDING, a wrong cert and a keystore with two keys), record-cert (dispatch only, `release` environment, prints the fingerprint). release.yml calls it for stable only and signs in the release job through `scripts/native/android-release.sh` (separate sideload secrets ANDROID_SIDELOAD_*, pin from the previous release tag, one skip line if a secret is missing, repo variable ANDROID_SIGNING=required turns the skip into a failure). The APK ships as `Vyre_<version>_android.apk` and `Vyre-android.apk`, in SHA256SUMS before the Ed25519 signature; `check-release-dist --android` gates it. The box-signed channel (app.yml) is now `sh.vyre.app.box` and `vyre phone add --android --usb` opens that package. apps/ios and apps/android lost their workflows. (3) The permission check runs in both builds (aapt2 for the APK, plutil on the archive's Info.plist files). (4) `native-ios.yml` is reusable: build (macOS, no secret, unsigned archive, tarball + sha256) and upload (`apple` environment, tags only, `scripts/native/ios-upload.sh`, App Store Connect key, one skip line); release.yml calls it and no job waits for it.
- Not proven until a real account exists: that `xcodebuild -exportArchive -allowProvisioningUpdates` re-signs an archive built with CODE_SIGNING_ALLOWED=NO (if it will not, the fallback is signing at archive time inside the apple job); which App Store Connect key role is enough for cloud-managed signing (Apple may demand Admin); that the called workflow's `apple` and `release` jobs read the environments' secrets without `secrets: inherit`. The AutoFill extension config plugin (10 h in NATIVE-APPS.md) is not built; the iOS archive today is the plain Expo app.
- Setting the key up (the user): `keytool -genkeypair -keystore sideload.p12 -storetype PKCS12 -alias vyre-sideload -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=Vyre sideload, O=Vyre"`, one key only; secrets in the `release` environment: ANDROID_SIDELOAD_KEYSTORE_B64 (`base64 -i sideload.p12`), ANDROID_SIDELOAD_KEYSTORE_PASSWORD, ANDROID_SIDELOAD_KEY_ALIAS, ANDROID_SIDELOAD_KEY_PASSWORD. Then run native-android with record_cert, check the fingerprint, commit it as the `sideload` line of docs/native/android-cert.sha256. The sideload key cannot be reset, so keep a second copy of the keystore offline.

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

0. Native apps: Gradle dependency verification (`gradle/verification-metadata.xml`, generated by a CI run and committed, copied into the prebuilt android/ and enforced; reviewer-2 change 1, parked in BACKLOG), the gradle wrapper checksum pin, the AutoFill config plugin for iOS, the review server script (create the droplet only at the first external TestFlight or App Store review), the first real runs once the Apple and Android identities exist.
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
