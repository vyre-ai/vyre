# vault

Branch: work/vault · Worktree: ../vyre-vault · Milestone: M3 · Wave 1

## Scope

Owns `core/vault/`, `core/cli/commands/vault.js`, `docs/adr/0001-vault-crypto.md` (write it first).

Credentials sealed at rest, released one item at a time to a module that declared it, never shown
on any screen, log or event (floor rule 8). The case this exists for: a teammate leaves with an
.env file of shared secrets. That must be impossible, and offboarding must be one action.

- **Sealing.** Items are encrypted at rest in `~/.vyre/vault/` (mode 0700), with keys from the OS
  keychain on macOS (`security`) and a key file readable only by the vyred user on Linux, or a
  passphrase. Use only `node:crypto` (AES-256-GCM, scrypt or HKDF). Put the reasoning in the ADR.
- **Items.** `{ name, kind: "secret"|"login"|"card"|"note", description, fields }`. Names and
  descriptions are listable; values never are.
- **Release.** The internal tool `vault.release {name}` (register it with `internal: true`; the
  registry already routes `ctx.vault.fetch` to it and passes `caller: "module:<name>"`). It
  checks a grant for that module exists, returns `{ value }`, and records who fetched what and when
  (never the value).
- **Passes** (sharing with another person's Vyre over Tailscale). **Relayed** by default: the value
  never leaves this box; the holder's calls go through this box and it adds the credential at the
  boundary; revoke ends access at once. **Sealed** on request: an encrypted copy for offline use;
  revoking lists the item as "rotate". A pass has a holder, items, an expiry and a note.
- **Offboard.** `vault.offboard {person}` revokes every pass they hold and returns what must be
  rotated (every sealed item they received).
- **Import.** `vault.import` from a `.env` file (names become items; the file is left alone and the
  user is told to delete it), later 1Password/Bitwarden CSV.
- **`vyre vault run <name...> -- <cmd>`** injects values into that one child process's
  environment. Nothing is printed. The `use-the-vault` skill already tells Claude to use this.

## Tools

`vault.put {name, kind?, description?}` (the value arrives over the socket from the CLI's hidden
prompt; never through MCP), `vault.list`, `vault.grant {name, module}`, `vault.revoke`,
`vault.pass.create {holder, items, mode?: "relayed"|"sealed", expires?}`, `vault.pass.list`,
`vault.pass.revoke`, `vault.offboard {person}`, `vault.import {file}`, `vault.audit {name?}`, and
internal `vault.release`.

Refuse `vault.put` from caller `mcp`: Claude must never be the channel a value travels through.

## Events

`vault.item-added`, `vault.granted`, `vault.revoked`, `pass.created`, `pass.revoked`,
`person.offboarded`, `vault.released` (name, module; never the value).

## Port from

`the prototype's bin/vault.cjs`, `broker.cjs`, `vaultsync.cjs`, `vaultimport.cjs`. Read their headers for
the reasoning. Never open or print the real secrets files they point at.

## Done when

- Put, list, grant, fetch through a real module's `ctx.vault.fetch`, revoke, pass, offboard, all
  tested with a temp home. A test proves no value appears in events, logs or `vault.list`.
- Relayed pass exercised for real between two vyred instances (two temp homes on one machine is
  acceptable for the first merge; two machines on the tailnet before M3 is called done).
