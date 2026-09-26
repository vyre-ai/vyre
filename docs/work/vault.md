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

## Doing

- Nothing. Waiting for review before the merge.

## Next

1. The relayed pass between two machines on the tailnet (needed before M3 is called done). This
   needs the box workstream to bind `vault.relay` to the tailnet address, and ideally to check
   Tailscale identity on the listener as well as the signature.
2. `vault.fill` for unlocked surfaces (Touch ID through the Capsule helper, a passphrase on the
   Deck) and the Chrome extension on top of `vault.match`.
3. 1Password `.1pux` import (a zip reader over `node:zlib`).
4. `vyre vault export --sealed`, a passphrase-sealed backup, since losing the keychain item loses
   the vault.
5. Grants for relayed items on the holder's side: today any module on the holder's box may call
   `vault.relay` for an item held there.
6. A scan for `.env` files in project folders, offering to import each and delete it.

## Needs from others

- box: bind `vault.relay.host` to the tailnet address and set `vault.relay.url` to the
  `<you>.vyre.run` form; pass Tailscale identity headers to the listener if it can.
- watchers: use `ctx.vault.fetch(name, { watcher })` from the runtime (manifest
  `needs.vault: ["per-watcher"]`); grants are `vault.grant {name, module: "watchers", watcher}`.
- switchboard: agents' `auth.vault` items (setup token, API key) come through
  `ctx.vault.fetch(name)` with a grant to the `switchboard` module.
- gate (M9): take over adding credentials at the boundary; the relay listener becomes its client.

## Changed contracts

- `ctx.vault.fetch(name, { field?, watcher? })`: the second argument is new and optional.
- `vault.release {name, field?, watcher?}` (internal) returns `{ value }`. It requires an active
  grant for exactly the calling module (and watcher); the manifest declaration alone is not
  enough.
- `vault.put {name, kind?, description?, value? | fields, url?, hosts?, grants?}` returns
  `{name, kind, created, granted?}`. Callers are cli, local and modules; never mcp. A module may
  only create items or replace its own (origin `module:<name>`), and `grants` (module names) is
  for modules only, applied to the item it just put.
- Tool definitions may carry `callers: ["cli", "local", "mcp", "module"]`. Other callers get
  `denied`, and `GET /v1/tools` lists only what the requesting caller may use.
- vyred treats an HTTP `x-vyre-caller: module:*` header as `local`.
- Events: `vault.item-added`, `vault.item-changed`, `vault.item-deleted`, `vault.granted`,
  `vault.revoked`, `vault.released` (`{name, module}` or `{name, pass, holder}`),
  `grant.requested`, `pass.requested`, `pass.created`, `pass.revoked`, `pass.accepted`,
  `person.offboarded`. None carries a value.
- Config: `vault.keystore` (`keychain` | `file` | `passphrase`), `vault.keychain` (a keychain
  file), `vault.relay` (`{host, port, url?}`).
