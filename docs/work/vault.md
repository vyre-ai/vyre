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
  (`fill.js`, `modules/vault-extension/`, `docs/adr/0001-autofill.md`).
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

## Doing

- The relayed pass between two machines on the tailnet, end to end through the box
  workstream's Docker Compose stack and tailscale sidecar. Waiting on that stack reaching main.

## Next

1. The Capsule calling `vault.device.unlock` after Touch ID.
2. Grants for relayed items on the holder's side: today any module on the holder's box may call
   `vault.relay` for an item held there.
3. A scan for `.env` files in project folders, offering to import each and delete it.
4. Loading the Chrome extension in a real browser. It is tested only by its manifest and the
   listener's HTTP contract.

## Needs from others

- box: bind `vault.relay.host` to the tailnet address and set `vault.relay.url` to the
  `<you>.vyre.run` form; pass Tailscale identity headers to the listener if it can.
- watchers: use `ctx.vault.fetch(name, { watcher })` from the runtime (manifest
  `needs.vault: ["per-watcher"]`); grants are `vault.grant {name, module: "watchers", watcher}`.
- switchboard: agents' `auth.vault` items (setup token, API key) come through the `agents`
  module's `ctx.vault.fetch(name)` (manifest `needs.vault: ["per-agent"]`), with a grant per item
  to `agents`.
- gate (M9): take over adding credentials at the boundary; the relay listener becomes its client.

## Changed contracts

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
  - Not yet: multi-device join (`vault.device.join`, `vault.device.approve`), deleting shared
    items, CLI verbs for the vault tools (use `vyre call`), and a periodic pull.
