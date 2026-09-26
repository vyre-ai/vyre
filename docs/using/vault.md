---
title: Vault
summary: Store credentials sealed, let a module, watcher or agent use one without seeing it, share with a person by pass, fill logins in the browser, and know what the Vault never shows.
audience: users, agents
owner: docs
status: stable
---

# Vault

The Vault keeps your credentials sealed at rest and releases them one item at a time, only to a
module, watcher or agent you granted that item to. Agents use items by name and never see them.
People share items by **pass**, and when someone leaves, one command revokes everything they
hold and lists what to rotate. It is also a password manager for you: logins with one-time codes,
cards, notes, API keys, env sets and SSH keys, with a generator, import, and autofill in the
browser.

## The floor rule

No value from the Vault appears on any screen, log or event, except to a person who has just
proved presence on their own device, for that one value. Never to a model, an agent, a log or an
event. This is floor rule 8 in the [security floor](../concepts/floor.md), and it cannot be
switched off.

In practice:

- `vault.list`, `vault.item`, `vault.search`, `vault.audit`, `vault.history`, events, logs, errors
  and the MCP listing carry names, kinds, field names and hosts. Never a value.
- `vault.put` refuses Claude. Values come from `vyre vault put`'s hidden prompt, from a file vyred
  reads itself (`vault.import`), or from a module. Claude is never the channel a value travels
  through.
- Showing, copying or filling a value needs you to prove you are present, with Touch ID, a
  passkey or the terminal. See [presence](../concepts/presence.md). A call from Claude alone cannot
  pass it.

## Store an item

```
vyre vault put stripe-live --kind api-key --description "Harlow Legal Stripe" --host api.stripe.com
```

`put` prompts for the value without echo, or reads piped stdin. Never put a value on the command
line, where shell history and Claude's transcript would see it. Kinds are `secret`, `api-key`,
`login`, `card`, `note`, `env-set` and `ssh-key`. For a login, add `--username` and `--totp` to
store a one-time-code seed.

Other ways in:

```
vyre vault import ~/Downloads/1password-export.csv   # also .env, Bitwarden, Chrome, Safari
vyre vault generate --words 5 harlow-wifi             # stored, never printed, because it is named
vyre vault ssh generate deploy-key                    # prints only the public key
```

`import` reads the file inside vyred, so the values never pass through Claude. Delete the file
afterwards.

## See what you have

```
vyre vault                    # every item: name, kind, grants; never a value
vyre vault get stripe-live    # one item's metadata
vyre vault audit stripe-live  # who used it, when, and whether it was allowed
```

In the Deck, **Vault** (`/vault`) lists items by kind, with **Watchtower** (weak, reused, old or
missing two-factor), **Passes**, **Shared with you** and **Devices**. Every field shows as twelve
dots whatever its length.

## Show, copy or fill a value yourself

Each of these asks you to prove presence first, and each is for one value:

```
vyre vault get stripe-live --copy       # to the clipboard, cleared after 90 seconds
vyre vault get harlow-portal --otp      # the current one-time code
vyre vault totp harlow-portal
```

- **Deck**: Copy asks vyred to write the clipboard; the value never comes back to the page.
  Reveal shows one field in the item pane and hides it again after 30 seconds, when the window
  loses focus, or when you leave the item.
- **Capsule**: press Control twice, type the item's name, and choose **Fill in the front app**,
  **Copy the password or key**, **Copy username**, **Copy one-time code** or **Show the one-time
  code**. Fill types the login into the app in front through a helper; the value never returns
  to the Capsule (`vault.fill.native`).

## Let an agent, module or watcher use an item

A grant lets one module, or one watcher, fetch one item. Agents run as the `agents` module, so an
agent's setup token or API key is granted to `agents` (see [agents](agents.md)).

```
vyre vault grant stripe-live billing                      # a module
vyre vault grant billing-inbox watchers --watcher harlow-invoices
vyre vault revoke billing-inbox watchers --watcher harlow-invoices
```

When Claude asks for a grant (`vault.grant`), it only creates a pending request. You approve it:

```
vyre vault pending
vyre vault approve <id>
```

or from **Passes** in the Deck, where what waits for you is at the top. Taking access away never
needs presence; giving it always does.

**Release** is what happens at use time: the module calls `ctx.vault.fetch("<name>")` (a watcher
calls `vault.fetch`), and vyred checks the grant and hands that one value to that one caller. The
internal tool is `vault.release`, which no surface or model can call. Every use is written to the
audit log, by name.

## Use an item in a script

Scripts outside Vyre run under `vyre vault run`, which puts the values into one child process's
environment and scrubs them from its output:

```
vyre vault run STRIPE_KEY=stripe-live -- npm run charge
vyre vault run --env-file .env.vyre -- node server.js      # KEY=vault://item/field lines
vyre vault inject -i config.tpl -o config.json              # {{ vault://item/field }}; vyred writes the file, 0600
```

These need presence, so Claude's own shell cannot use them to read a value.

## Share with another person

A pass shares items with another person's Vyre. Exchange cards first, and compare fingerprints
out of band:

```
vyre vault card                                   # yours, to send them
vyre vault people add <their card> --name dana
vyre vault fingerprint dana                       # the four safety words you should both see
vyre vault people verify dana <fingerprint>
vyre vault share stripe-live --with dana --host api.stripe.com --expires 30d
```

- **Relayed** (the default): the value never leaves your box. Dana's calls go through your Gate
  over Tailscale with `vault.relay`, your Vyre adds the value, and revoking ends her access at
  once.
- **Sealed** (`--sealed`): Dana gets an encrypted copy, for offline use. Revoking a sealed pass
  means rotating the credential.

```
vyre vault pass list
vyre vault pass revoke <id>
vyre vault offboard dana       # revoke every pass she holds and list what must be rotated
```

For a team, `vyre vault vaults create` makes a shared vault and `vyre vault members invite` adds
people to it.

## Autofill in the browser

The Chrome extension in `modules/vault-extension/` fills logins from your Vault.

1. Set `vault.fill` in `config.json`, for example `{ "host": "127.0.0.1", "port": 7788 }`, and
   restart vyred.
2. In `chrome://extensions`, turn on Developer mode and **Load unpacked** that folder.
3. Set the passphrase the extension asks for: `vyre vault unlock-passphrase`.
4. Pair it: `vyre vault pair` prints an 8-character code that works once, for 5 minutes.

On a login page, unlock with the passphrase (or Touch ID through the Capsule) and choose **Fill**.
Only logins whose hosts include the page's exact origin are offered, so a lookalike domain gets
nothing. An unlock lasts 10 minutes without a fill, 12 hours at most. `vyre vault devices` lists
paired browsers; `vyre vault devices revoke <id>` ends one at once. The design is in
[ADR 0010](../adr/0010-vault-autofill.md).

Autofill on the phone is not built yet.

## Your personal vault, and getting it back

```
vyre vault account create         # sets the password; prints your Secret Key once
vyre vault kit                    # a recovery kit: a one-time page on this machine
vyre vault account enroll-touchid
vyre vault account lock
```

Keep the recovery kit. Your agents keep what is granted to them while your personal vault is
locked. `vyre vault backup <file>` writes the whole vault sealed to a passphrase of its own.

## Which surface does what

| Task | Terminal | Deck | Capsule | Claude |
| --- | --- | --- | --- | --- |
| Add an item | `vyre vault put`, `import` | Add, per kind | | `vault.import` (a file path), never a value |
| List items | `vyre vault` | `/vault` | type a name | `vault.list` (names only) |
| Copy, reveal, code | `get --copy`, `--otp`, `totp` | Copy, Reveal | Copy, Show the code | never |
| Fill a login | | | Fill in the front app | never |
| Grant | `vyre vault grant`, `approve` | Passes | | `vault.grant` (waits as pending) |
| Share | `vyre vault share` | share sheet | | `vault.pass.create` (waits for approval) |
| Offboard | `vyre vault offboard` | offboard sheet | | `vault.offboard` |

Inside a Claude Code session, the `use-the-vault` skill tells Claude these rules.

## What it will not do

- Show a value to Claude, an agent, a log or an event.
- Take a value from Claude. `vault.put` refuses it.
- Let Claude approve its own grant or pass.
- Fill a login on a page whose origin is not one of the item's hosts.
- Passkeys are not built yet.

## Next

- [Presence](../concepts/presence.md): how you prove you are at the machine.
- [Watchers](watchers.md): the most common thing to grant an item to.
- Design: [ADR 0001](../adr/0001-vault-crypto.md), [ADR 0006](../adr/0006-vault-next.md),
  [ADR 0010](../adr/0010-vault-autofill.md).
- Every tool: [vault](../reference/tools.md#vault). Every command:
  [`vyre vault`](../reference/cli.md#vyre-vault), or `vyre vault help`.
