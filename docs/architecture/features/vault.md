---
title: Vault
summary: Credentials kept sealed at rest, shared by grant, lease or pass, and released to a module or an agent without a model ever seeing the value.
audience: builders, agents
owner: docs
status: stable
---

# Vault

## What it is

The Vault keeps passwords, API keys, tokens, cards, notes and SSH keys sealed on disk and hands one item at a time to a module, watcher or agent that holds a grant for it. A value is shown only to a person who has just proved presence on their own device, and never to a model.

## What a person sees

The Vault screen is in `apps/app/screens/vault/`. The header says "Vault". A scope switch reads "Space" and "Mine" (the Space's vault and the person's own). Before a member has an account the screen says "Make your own vault" and asks for a "Master password"; a locked vault says "Your vault is locked" with "Unlock".

- **Ten groups**, in this order, in the list, the sidebar panel and the Add picker (one list, `GROUPS` in `apps/app/screens/vault/redesign.js`): AI models, Email and sending, Phone and texts, Google and Microsoft, Code and hosting, Messaging, Logins, SSH keys, Secure notes, Any API key.
- **Panel picks**: all, one group, "Expiring" (expiring or expired), "Shared with me".
- **Add** opens a picker by provider ("Search what to add", for example Twilio or password). The sheet is titled "Add to the Space vault" or "Add to your vault" and shows the fields of the chosen provider in its console's order. "Bring in passwords and keys" imports from another password manager or from `.env` files.
- **An item** shows "The value" (hidden), "Used by", "Who has it", and the actions Open, Share, Delete. Sharing offers two levels: **Can use** ("Can use, without seeing it") and **Can edit** ("Can also change or replace it").
- Health words: Healthy, Expiring (within 14 days), Expired, Unused (never used, or not for 90 days).
- A revealed value stays up 60 seconds and a copied value is cleared from the clipboard after 30 (`REVEAL_MS`, `CLIPBOARD_MS`).

## How it works

**Sealing.** `core/vault/crypto.js` uses only `node:crypto`: AES-256-GCM, Argon2id (or scrypt) for the password, Ed25519 to sign relay requests, X25519 to seal an item for another person's Vyre. Each item version has its own item key, wrapped under the vault key. A device key opens the agent vault; a key made from the master password plus the Secret Key opens the personal vault. The Secret Key is created with the account (`vault.account.create`), returned once to a terminal or local surface for the recovery kit (`core/vault/kit.js`, served once from loopback), and never written to a log, event or audit row.

**Member vaults.** Each member has a vault of their own on the Space's server (`core/vault/people.js`, one folder and database per person under `people/<id>`). The member's device supplies the Secret Key for each unlock, so the server's disk holds ciphertext only. The `vault.me.*` tools (`core/vault/tools/me.js`) act on the one person the kernel names for the call and refuse the owner, a model and more than one person. The Space owner's vault is the `vault.*` tools; `core/vault/member-gate.js` refuses any `vault.*` call made for a non-owner unless the name is in its allowed list.

**Releasing.** `vault.release` is an internal tool for modules: it returns one field to a module (or to Publish for a deployment) that holds a grant, and `project`, when the grant names one, must match. `vault.granted` lets a module ask whether it holds a grant. `vault.grant` from a model waits as a request (table `vault_access_requests`) until a person runs `vault.approve`; taking access away (`vault.revoke`) needs no one.

**Lending a login to an agent.** Lending is a kernel grant (`core/vault/access.js`): the agent's stable id, action `vault.fill`, on the item's address in the owner's personal vault, at one exact origin, until an expiry. The vault keeps no table of who may use what. `vault.agent.fill` signs an agent in on its own computer by driving the page over CDP; the agent receives `{ filled, origin, navigated, tab }`, never a field (`core/vault/agent-fill.js`).

**Task leases.** `vault.connections.lend` (flows only) lets a task's doer use named Connections for that task, only credentials named by the task's approved Kit version, use only, until a time. `vault.connections.end` takes them back. Events: `vault.lease-lent`, `vault.lease-ended`.

**Sharing with a person.** `vault.access.set` (`core/vault/tools/sharing.js`) makes a kernel grant for a current Space member: actions `vault.use` for Can use, `vault.use` plus `vault.edit` for Can edit, source `vault:share:<item>:<person>`. A level of null ends it. `vault.access.get` lists who has it. Shared vaults between people are separate: `vault.vaults.create`, `vault.members.invite`, `vault.members.role` (admin, member, read-only), sealed per member with X25519.

**Sealed values.** A model never gets a vault value, and a sealed record field reaches a model only as a placeholder (`lib/sealed.js`). `vault.put` is not open to the `mcp` caller. `vault.reveal` and copy run only on a person's surface with a presence check, and write `vault.revealed` and `vault.copied` events with the field name, not the value.

**Providers catalog.** `core/vault/providers.js` lists the services a module may need a credential for: item kinds that hold it, how it is given (`field`, `file` or `oauth`), the fields to ask for with loose shape patterns, the capabilities (`send_mail`, `read_mail`, `calendar`, `files`, `send_message`, `speech`, `llm`, `search`, `other`) and where to get the key. The Add picker and `core/vault/connections.js` read it; nothing in it holds a value.

**Data and events.** Tables are in `core/vault/vault.js` (`MIGRATIONS`) plus `vault_access_requests` and `vault_conversions`. Events include `vault.item-added`, `vault.item-changed`, `vault.item-deleted`, `vault.granted`, `vault.revoked`, `vault.released`, `vault.refused`, `vault.unlocked`, `vault.locked`, `vault.filled`, `pass.created` and `pass.revoked`. Settings: `vault.lock_idle` (10m), `vault.lock_max` (12h), `vault.lock_on_sleep`, `vault.lock_on_screen_lock`.

## Where the code lives

- `core/vault/index.js`: tool layer and caller rules; `core/vault/module.json`: tool list with `reach`.
- `core/vault/vault.js`, `core/vault/crypto.js`, `core/vault/store.js`: items, keys, migrations.
- `core/vault/people.js`, `core/vault/tools/me.js`, `core/vault/member-gate.js`: member vaults and the owner gate.
- `core/vault/access.js`, `core/vault/agent-fill.js`, `core/vault/tools/sharing.js`: agent grants, leases, sharing.
- `core/vault/providers.js`, `core/vault/connections.js`: catalog and Connections.
- `core/vault/import.js`, `core/vault/envscan.js`, `core/vault/generate.js`: bring-in, `.env` scan, generator.
- `core/vault/passmcp.js`, `core/vault/tools/mcp.js`: Vault MCP passes for outside agents.
- `core/vault/backup.js`, `core/vault/emergency.js`, `core/vault/health.js`: backup, emergency access, health.
- `lib/vault-kinds/kinds.js`: item kinds and their fields; `lib/sealed.js`: placeholders.
- `apps/app/screens/vault/`: the Vault screens.

## How agents use it

- `vault.list`, `vault.item`, `vault.search`, `vault.history` are open to models and return names, kinds, field names and hosts, never a value. A model is told about an item only if it holds a grant on it; any other name answers as if it did not exist (`core/vault/tools/cli.js`).
- `vault.grant` from a model waits for a person (`vault.pending`, then `vault.approve` which is person-only).
- `vault.put`, `vault.reveal`, `vault.copy`, `vault.inject`, `vault.rotate` and `vault.access.set` are person surfaces only (cli, local, deck, capsule, plus device or tailnet for reveal and copy); a model is refused.
- An agent asks for a use, not a value: it names the item and the system attaches the key. If a sign-in is missing it marks the task stuck with a suggested fix naming the item, and the person's card opens the Add sheet.
- See sealed values and secrets (agent doc "sealed-and-secrets"), connections (agent doc "connections") and outward acts (agent doc "outward-acts").

## Limits today

- A member's own vault holds their sign-ins, mail and calendar connections and server list. Sessions do not read other items in it yet.
- A member cannot add a setup token or API key as their own AI account.
- The firm Microsoft 365 app is read-only; member sends are not open.
- On the web, a member's Secret Key sits in browser storage, readable by the app's own scripts. It opens nothing without the master password.
- Nothing has been walked on a real iPhone or Android, including Face ID pairing.

## Related

- [Gate](./gate.md), [Kernel](./kernel.md), [Identity and devices](./identity-and-devices.md), [Spaces and members](./spaces-and-members.md), [Sites and publishing](./sites-and-publishing.md), [MCP and engineer](./mcp-and-engineer.md)
- [Map](../map.md), [Overview](../overview.md)
- [Using the Vault](../../using/vault.md), [Presence](../../concepts/presence.md), [Security floor](../../concepts/floor.md)
- [Known gaps](../../known-gaps.md), [Tools reference](../../reference/tools.md)
