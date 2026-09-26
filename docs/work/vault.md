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

- Surfaces (ADR 0006 decisions 2 to 4, section 6): surface sessions (`session.js`), reveal and
  copy with the clipboard helper (`clipboard.js`, `mac/clip.swift`), lock on sleep and screen
  lock (`watch.js`, `mac/watch.swift`), native fill for the Capsule (`native.js`,
  `mac/type.swift`), tools in `tools/surfaces.js`; the extension's inline chooser, keyboard fill,
  one-time codes and save on submit (`fill-save.js`, `modules/vault-extension/inline.js`).

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
