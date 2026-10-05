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

## The rule that has no off switch

No value from the Vault appears on any screen, log or event, except to a person who has just
proved presence on their own device, for that one value. Never to a model, an agent, a log or an
event. This is rule 8 of Vyre's nine [security rules](../concepts/floor.md), and it cannot be
switched off.

In practice:

- `vault.list`, `vault.item`, `vault.search`, `vault.audit`, `vault.history`, events, logs, errors
  and the MCP listing carry names, kinds, field names and hosts. Never a value.
- `vault.put` refuses Claude. Values come from `vyre vault put`'s hidden prompt, from a file Vyre
  reads itself (`vault.import`), or from a module. Claude is never the channel a value travels
  through.
- Showing, copying or filling a value needs you to prove you are present, with Touch ID, a
  passkey or a code typed in your terminal. See [presence](../concepts/presence.md). A call from
  Claude alone cannot pass it.

Vyre asks you to prove you are there (Touch ID on a Mac, a passkey in the Vyre app or on the phone)
for three kinds of thing: pairing a new Mac, releasing a vault secret (show, copy, fill, a
one-time code, a backup), and anything that goes out as you, which is a send, a post, a payment or
a delete. Reading a list of names asks for nothing. Unlocking your personal vault with its password
asks for the password itself and nothing else, and Touch ID unlock asks for Touch ID; either one
only opens the vault, and a secret still needs its own proof to be released.

## Store an item

1. Run `put` with the item's name, kind and the origins it may be sent to:

   ```
   vyre vault put stripe-live --kind api-key --description "Harlow Legal Stripe" --host https://api.stripe.com
   ```

2. Type the value at the hidden prompt, or pipe it on stdin. Never put a value on the command
   line: shell history and Claude's transcript would see it, and `put` refuses it.

   ```output
     stored stripe-live · api-key · sent only to https://api.stripe.com
   ```

Kinds say what an item is, so the vault knows which field to hand over and what to warn about:

| Kind | Holds | Hands over |
|---|---|---|
| `login` | username, password, one-time-code seed | password |
| `authenticator` | a one-time-code seed on its own | the code |
| `passkey` | a site's passkey | nothing: it signs inside the vault |
| `card`, `address`, `identity` | payment cards, addresses, ID documents | card number; name the field |
| `note` | text | text |
| `api-key`, `secret` | one value | value |
| `pat` | a personal access token, with its scopes and expiry | token |
| `oauth` | client id and secret, access and refresh tokens | the first token present |
| `cloud` | AWS keys, a service-account JSON, an Azure secret | the secret |
| `db-url` | a database URL | url |
| `env-set` | a .env file's variables | name the variable |
| `ssh-key` | an SSH key | nothing: it signs through the ssh agent |
| `cert` | a certificate and its key | certificate |
| `recovery-codes`, `wifi`, `license`, `file` | backup codes, a network, a licence key, a small file | codes, password, key, content |

```
vyre vault put kit-github --kind pat --provider github --scope repo --scope read:org --expires 90d
vyre vault put northwind-aws --kind cloud                # access key id, then the secret, hidden
vyre vault put harlow-gcp --kind cloud --from sa.json   # a service account file
vyre vault put harlow-tls --kind cert --from cert.pem --key-from key.pem
vyre vault put northwind-guest --kind wifi --ssid "Northwind Guest"
```

The list shows each item's details: the provider, a PAT's scopes, a certificate's end date (read
from the certificate itself), a network name, how many recovery codes are left. Details never
hold a value. Watchtower flags anything `expired`, and anything `expiring` within 14 days. For a
login, add `--username <name>` and `--totp` to store a one-time-code seed (`--totp` needs a
terminal). For an env set, or to name the fields of any kind, use `--field NAME`.

> [!SNAG] hosts must be origins such as https://api.example.com
> `--host` takes a whole origin, with the scheme: `--host https://api.stripe.com`, not
> `--host api.stripe.com`. With `--url` and no `--host`, the URL's origin is used.

Other ways in:

```
vyre vault import ~/Downloads/1password-export.csv   # any password manager's export, or .env files
vyre vault generate --words 5 harlow-wifi             # stored, never printed, because it is named
vyre vault ssh generate deploy-key                    # prints only the public key
```

`import` reads the file inside Vyre, so the values never pass through Claude, and it leaves the
file alone. It reads 1Password (.1pux and CSV), Bitwarden (JSON and CSV), LastPass, Dashlane (the
zip or its CSVs), Keeper (CSV and JSON), NordPass, Proton Pass (the unencrypted zip, JSON or CSV),
Enpass, KeePass and KeePassXC (XML or CSV; export a .kdbx first), Chrome, Edge, Brave, Arc,
Firefox and Apple Passwords, and finds the format by itself. `--preview` shows what would come
in before anything is stored. Delete the file afterwards. `generate` without a name prints a password and stores
nothing.

A project's `.env` files come in the same way, a file or a whole folder at once:

```
vyre vault import ~/code/harlow-intake --preview   # every .env under it, typed, never a value
vyre vault import ~/code/harlow-intake --rewrite   # store them, then swap the values for references
vyre run -- npm start                              # reads ./.env's references; same environment as before
```

Each file becomes one env-set named after where it lives (`harlow-intake.env`,
`harlow-intake-apps-web.env.local`). Only secrets move: API keys, tokens, passwords, database URLs
with a password, private keys. Plain settings such as `PORT` or a public URL stay in the file. The
preview names each variable's type and provider (`api-key openai`, `db-url postgres`), flags a
public name holding a secret value (`NEXT_PUBLIC_...=sk_live_...`), and says when a file is
committed to git or missing from `.gitignore`. The scan skips `node_modules`, `.git` and build
folders, lists `.env.example` files without importing them, and follows no symlinks.
`--rewrite` changes a file only after every value in it is stored, writes no backup of the old
file, and leaves a file alone when its values differ from the vault's (a conflict).

## Leaks and rotation

```
vyre vault sweep ~/code/harlow-intake --history   # files and every commit; places and names only
vyre vault sweep --shell                          # also ~/.zsh_history and friends
vyre vault rotate kit-gitlab                      # a new token at GitLab, stored, the old one revoked
```

The sweep compares every value the vault holds with the files in a folder, and can also look
through the lines each git commit added and your shell history. It also spots credentials the
vault does not hold yet by their shape: a Stripe key, a GitHub token, a private key block. It
says where (file, line, commit) and what (the item's name, or the kind of credential), never the
value. A value in git history stays there after you delete the file, so rotate it.

`rotate` makes the new credential with the current one, stores it as a new version (the old one
stays in history), then revokes the old one. AWS access keys, GitLab tokens, Cloudflare API
tokens and Google Cloud service-account keys rotate by themselves. For everything else (GitHub,
OpenAI, Anthropic, Stripe and the rest) it gives the provider's page and the steps; paste the new
value with `vyre vault put`. The item needs its provider: `--provider github` on `put`.

Every morning after 09:00, Watchtower's findings become todos in the planner's Vault list: an
expired or soon-expiring token, a reused or old password, an item marked to rotate. Each is raised
once; more than five at once become one todo that lists them. Fixing the item closes its todo,
and a todo you dismiss stays dismissed until the reason changes. `vyre call vault.remind.run`
runs the pass now. Set `"reminders": false` under `vault` in config.json to turn it off.

## One-time codes

The vault is an authenticator too. Every login with a seed, and every `authenticator` item, shows
its current code and the next one, so a code about to roll over is never a guess:

```
vyre vault codes                         # every code: current, next, seconds left
vyre vault totp harlow-google            # one
vyre vault codes import --from codes.txt # Google Authenticator's export, as scanned text
```

To leave Google Authenticator, open it, choose Transfer accounts, then Export, and scan the QR
codes with the Vyre phone app. A large export is split across several codes;
the import waits until every part is scanned, in any order. A seed already in the vault is
recognised and skipped. Counter-based (HOTP) codes are not supported. `otpauth://totp/` links
work the same way.

## See what you have

```
vyre vault                    # every item: name, kind, grants; never a value
vyre vault get stripe-live    # one item's metadata
vyre vault audit stripe-live  # who used it, when, and whether it was allowed
```

In the Vyre app, **Vault** (`/u/vault`) has the sections **Items**, **Passes**, **Shared**,
**Devices** and **Health**. Health is the Watchtower: it flags weak or reused values and can check
for known breaches.

## Show, copy or fill a value yourself

Each of these is for one value, and asks you to prove presence first:

```
vyre vault get stripe-live --copy       # to the clipboard, cleared after 90 seconds
vyre vault get harlow-portal --otp      # the current one-time code
vyre vault totp harlow-portal           # the same
vyre vault read vault://stripe-live/value   # one field alone on stdout, for $(...) and pipes
```

::: tabs
::: tab On this Mac
The terminal asks for Touch ID (or your Mac password). After you cancel, the next request waits
30 seconds.
::: tab On a server
A terminal on the box cannot prove presence: the box has no Touch ID, and it does not accept a
terminal code. There, only a passkey from the Vyre app proves you are there. Use the app, or your
Mac.
:::

- **Vyre app**: **Copy** puts the value on the clipboard of the device you are on. **Reveal**
  shows one field and masks it again after 30 seconds.
- **Lumen**: press Control twice, type the item's name, and choose **Fill in the front app**,
  **Copy the password or key**, **Copy username**, **Copy one-time code** or **Show the one-time
  code**. Fill types the login into the app in front through a helper; the value never returns
  to Lumen (`vault.fill.native`).

The Vyre app, Lumen and the browser extension open a short **session** with one proof. While
it lasts, reveal, copy and one-time codes do not ask again, except for cards, which ask every
time. A session ends after 10 minutes idle or 12 hours at most, when the Mac sleeps or its screen
locks, or on `vyre vault lock`. Set other limits in `config.json` under `vault.lock`, for example
`{ "idle": "5m", "max": "8h" }`. The browser extension's fill window is fixed instead: 30 minutes
from the proof (see Autofill in the browser below).

## Let an agent, module or watcher use an item

A grant lets one module, or one watcher, fetch one item. Agents run as the `agents` module, so an
agent's setup token or API key is granted to `agents` (see [agents](agents.md)).

```
vyre vault grant stripe-live billing                      # a module
vyre vault grant billing-inbox watchers --watcher harlow-invoices
vyre vault revoke billing-inbox watchers --watcher harlow-invoices
```

When Claude asks for a grant (`vault.grant`), it only creates a pending request. You approve it:

1. List what waits: `vyre vault pending`.

   ```output
     g_4f2a  grant billing-inbox to watchers/harlow-invoices

     vyre vault approve <id>
   ```

2. Approve one: `vyre vault approve g_4f2a`. Or approve it from **Passes** in the Vyre app, where
   what waits for you is listed.

Taking access away never needs presence; giving it does.

> [!WHY] What happens when a module uses its grant?
> At use time the module calls `ctx.vault.fetch("<name>")` (a watcher calls `vault.fetch`), and
> Vyre checks the grant and hands that one value to that one caller. The internal tool is
> `vault.release`, which no surface or model can call. Every use is written to the audit log, by
> name.

## Connecting a key

A module says what it needs in its manifest (`needs.credentials`), and you fill each need in one
place. Voice needs a Deepgram, OpenAI or ElevenLabs key, for example, and any one of the three
will do.

1. See what every module needs, and what is still missing: `vyre vault needs`.

   ```output
     voice · speech not ready (one of deepgram, openai, elevenlabs)
       deepgram           missing  deepgram · push-to-talk words, streamed as you speak
       openai             missing  openai · push-to-talk words, transcribed on release
       elevenlabs         missing  elevenlabs · push-to-talk words and spoken replies
   ```

2. Fill one: `vyre vault connect voice deepgram`. It says where to get the key, then asks for it
   without echo. Leave out the need and it picks the first one still missing.

The key is checked against the provider (a pasted OpenAI key is refused in the Deepgram box),
saved with its kind and provider, and granted to the module, in one step that asks you to prove
you are there. A service-account key file goes in by path, `vyre vault connect <module> <need>
--file key.json`, and then asks for the email to act as. A Google sign-in stores nothing here: it
names the sign-in to run next. `vyre voice key` is a shortcut for `vyre vault connect voice`.

A need is `ready`, `missing`, `not_granted` (saved but not granted), `pending` (Claude asked for
the grant and it waits for you) or `expired`. Claude can never connect a key: the value only ever
comes from your own screen.

Some modules take several accounts of one kind, such as mail: give each a label, `vyre vault
connect mail imap --label northwind`, and each is its own item (`mail-northwind`).

## Vault, Connections

Every account and key Vyre can act through is one connection: your Google accounts, each MCP
server, each mailbox, and each key you connected. One list shows them side by side, with what
each can do and which surface may use it.

```bash
vyre vault connections
vyre vault connections --can send_mail
vyre vault connections --surface agents
```

```output
  cn_Vq3k9x0aB2c  kit at Northwind kit@northwind.test · google-dwd · service-account
                  can send_mail, read_mail, calendar · capsule, chat
  cn_Lm8Pz1yQw4r  Harlow Legal Gmail alex@harlowlegal.test · mcp · oauth
                  can send_mail, read_mail · capsule, chat
```

A surface is `capsule` (that is Lumen), `chat` (Claude in a thread), `agents` or `phone`. A new connection is
granted to Lumen and chat, so "send an email" in Lumen offers every account that can
send, and Claude in a chat thread sees the same list. Agents see nothing until you grant it:

```bash
vyre vault connections grant cn_Vq3k9x0aB2c agents
vyre vault connections revoke cn_Vq3k9x0aB2c chat
vyre vault connections sync
```

Pick a default per capability, `vault.connections.update {id, default_for: ["send_mail"]}`, and
it comes first wherever an account is chosen; after it, the one used most recently. Granting asks
you to prove you are there; revoking and picking a default never do. You can also rename a connection
or change what it can do (`vault.connections.update`), and that survives every resync. A
connection whose key is missing or not granted to its module shows `needs credential` and the
`vyre vault connect` that fixes it. A row someone changed behind the vault's back fails its check
and is granted to nothing until you grant it again.

Your Google accounts and MCP servers appear on their own: the vault reads them each time one is
added, changed or removed.

> **For module authors.** Register each account with `vault.connections.register {ref, provider,
> account, auth, label?, capabilities? or tools?, items?, use?}`; the source is your module's
> name. Before acting for a caller, ask `vault.connections.allowed {id, caller}` and refuse
> unless it says `allowed: true`. When a key is missing, answer with `{code: "needs_credential",
> message, detail: {module, need, account?}}` (core/modules/needs-credential.js). The vault
> emits `vault.connection-added`, `vault.connection-removed` and `vault.connection-changed`.

## Use an item in a script

Scripts outside Vyre run under `vyre vault run`, which puts the values into one child process's
environment and scrubs them from its output:

```
vyre vault run STRIPE_KEY=stripe-live -- npm run charge
vyre vault run --env-file .env.vyre -- node server.js      # KEY=vault://item/field lines
vyre vault inject -i config.tpl -o config.json              # {{ vault://item/field }}; Vyre writes the file, 0600
```

An item before `--` is `<name>`, `<name>.<field>`, `VAR=<name>` or `VAR=<name>.<field>`; without `VAR=`, the
variable is the name in capitals (`stripe-live` becomes `STRIPE_LIVE`). A value the child prints
shows as `<concealed by vyre>`. These need presence, so Claude's own shell cannot use them to read
a value.

## Share with another person

A pass shares items with another person's Vyre. In this example you share with Dana, who runs her
own Vyre.

1. Swap cards. Send Dana the output of `vyre vault card`, and add hers:

   ```
   vyre vault people add <her card> --name dana
   ```

2. Compare the four safety words out of band (on a call, in person). You both run
   `vyre vault fingerprint dana` and should see the same words. Then:

   ```
   vyre vault people verify dana <fingerprint>
   ```

3. Share:

   ```
   vyre vault share stripe-live --with dana --expires 30d
   ```

   It prints a ticket. The ticket carries no secret; send it to Dana.

4. Dana accepts it with `vyre vault pass accept <ticket>`.

A pass is one of two kinds:

- **Relayed** (the default): the value never leaves your box. Dana's calls go through your Vyre
  with `vyre vault relay` (`vault.relay`), your Vyre adds the value, and revoking
  ends her access at once. `--host`, `--method` and `--path` on `vyre vault pass create` narrow
  what her calls may reach.
- **Sealed** (`--sealed`): Dana gets an encrypted copy, for offline use. Revoking a sealed pass
  means rotating the credential.

> [!SNAG] stripe-live has no hosts it may be sent to, so it cannot be relayed
> A relayed pass sends the value only to the item's hosts. Store the item again with
> `--host https://api.stripe.com`, or share it `--sealed`.

To end sharing:

```
vyre vault pass list
vyre vault pass revoke <id>
vyre vault offboard dana       # revoke every pass she holds and list what must be rotated
```

For a team, `vyre vault vaults create <name>` makes a shared vault and
`vyre vault members invite <vault> <person>` adds people to it. Its items appear as
`<vault>/<item>`.

## Emergency access

Emergency access lets someone you trust open your items if something happens to you. They have
to ask, and then wait. You can stop it any time before the wait runs out. In this example Juno is
Alex's emergency contact.

1. Swap cards and verify fingerprints, as for a pass. Emergency access needs a verified card: a
   card that was only pinned, or whose key changed, is refused.
2. Alex keeps emergency access for Juno:

   ```
   vyre vault emergency add juno --wait 7d
   ```

   The wait is 1 to 30 days (7 by default). Without `--item`, it covers every item except ssh
   keys and passkeys. Alex's Vyre seals those items to Juno's key and keeps them in escrow. Neither
   Alex's box nor Juno can open them alone.
3. When Juno needs them, Juno runs `vyre vault emergency request alex`. Alex gets a todo in the
   Vault list of the planner: "juno asked for emergency access: it opens on <date> unless you
   deny it".
4. Alex can stop it with `vyre vault emergency deny juno`. Juno may ask again, and the wait
   starts again.
5. After the wait, `vyre vault emergency status alex` on Juno's Vyre takes the items in, the same
   way a sealed pass does.

The escrow is a snapshot. It is rebuilt when you unlock your personal vault, at most once a day,
and `vyre vault emergency refresh` rebuilds it now. `vyre vault emergency list` shows each
contact, the wait and where a request stands. `vyre vault emergency remove juno` ends it and
deletes the escrow. Once items are released, Juno holds copies, so rotate them if that was not
what you wanted.

## Autofill in the browser

The Chrome extension in `modules/vault-extension/` fills logins from your Vault.

1. Set `vault.fill` in `config.json`, for example `{ "host": "127.0.0.1", "port": 7788 }` (the
   extension looks at `http://127.0.0.1:7788` unless you change it), and restart Vyre (`vyre down`, then `vyre up`).
2. In `chrome://extensions` (Chrome, Arc, Edge, Brave), turn on Developer mode and **Load
   unpacked** that folder. In Firefox 121 or later, open `about:debugging`, choose **Load
   Temporary Add-on** and pick its `manifest.json`.
3. Set the passphrase the extension asks for: `vyre vault unlock-passphrase`.
4. Pair it: `vyre vault pair` prints an 8-character code that works once, for 5 minutes. Type it
   into the extension.

On a login page, unlock with the passphrase (or Touch ID through Lumen) and choose **Fill**.
Only logins whose hosts include the page's exact origin (scheme, host and port) are offered, so a
lookalike domain gets nothing. An unlock lasts 30 minutes from the proof, and filling does not
extend it; `vault.fill.window` in `config.json` (minutes, 1 to 30) makes it shorter. The same
extension loads in Firefox; see `modules/vault-extension/README.md`.
`vyre vault devices` lists paired browsers; `vyre vault devices revoke <id>` ends one at once. The
design is in [ADR 0010](../adr/0010-vault-autofill.md).

### Cards and addresses

In a checkout or address form, the extension offers your cards and addresses as it offers
logins; the popup lists them too. They are not tied to a site. A card asks every time by default:
fill it within a minute of unlocking, or unlock again. The PIN is never filled. Card fields inside
a payment provider's own frame (Stripe Elements and the like) are not filled yet.

### Passkeys

With the extension paired, a site that offers a passkey asks Vyre first: "Save a passkey for
harlow.test in Vyre?" when you make one, and "Sign in to harlow.test as alex with Vyre?" when you
use one. Continue works inside your unlock window. **Use another device** hands the request to
the browser's own authenticator (a phone, a security key, iCloud Keychain). Passkeys are items of
kind `passkey`; their private keys stay in the vault and only sign, so nothing can show, copy or
hand one out. The popup's "Use Vyre for passkeys" turns it off. Firefox needs version 128.

Autofill on the phone is not built yet.

## Your personal vault, and getting it back

```
vyre vault account create         # sets the password; prints your Secret Key once
vyre vault kit                    # a recovery kit: a one-time page on this machine
vyre vault account enroll-touchid
vyre vault account lock
```

The Secret Key is printed once and not written to any file. Keep the recovery kit. Your agents
keep what is granted to them while your personal vault is locked.

`vyre vault backup <file>` writes the whole vault sealed to a passphrase of its own, and
`vyre vault restore <file>` reads one back.

> [!SNAG] The vault is locked (exit code 4)
> With the passphrase keystore, run `vyre vault unlock`. For your personal vault, run
> `vyre vault account unlock` (add `--touchid` once you enrolled it), or unlock in the Vyre app.
> Unlocking with Touch ID meets the `presence_required` problem above. Unlocking with the password
> asks once, for the password itself. After five wrong passwords in a row, Vyre refuses every try
> for 30 seconds, then 60, doubling up to 15 minutes, and a right password starts the count over.
> Touch ID unlock never passes through that count, so it still works during the wait.

## Which surface does what

| Task | Terminal | Vyre app | Lumen | Claude |
| --- | --- | --- | --- | --- |
| Add an item | `vyre vault put`, `import` | Add an item | | `vault.import` (a file path), never a value |
| List items | `vyre vault` | `/u/vault` | type a name | `vault.list` (names only) |
| Copy, reveal, code | `get --copy`, `--reveal`, `--otp`, `totp` | Copy, Reveal | Copy, Show the code | never |
| Fill a login | | | Fill in the front app | never |
| Grant | `vyre vault grant`, `approve` | Passes | | `vault.grant` (waits as pending) |
| Share | `vyre vault share` | share sheet | | `vault.pass.create` (waits for approval) |
| Offboard | `vyre vault offboard` | offboard sheet | | `vault.offboard` (asks you for presence) |

Inside a Claude Code session, the `use-the-vault` skill tells Claude these rules.

## What it will not do

- Show a value to Claude, an agent, a log or an event.
- Take a value from Claude. `vault.put` refuses it.
- Let Claude approve its own grant or pass.
- Fill a login on a page whose origin is not one of the item's hosts.
- Hand out a passkey's private key. A passkey only signs inside the vault.

## Next

- [Presence](../concepts/presence.md): how you prove you are at the machine.
- [Watchers](watchers.md): the most common thing to grant an item to.
- Design: [ADR 0001](../adr/0001-vault-crypto.md), [ADR 0006](../adr/0006-vault-next.md),
  [ADR 0010](../adr/0010-vault-autofill.md).
- Every tool: [vault](../reference/tools.md#vault). Every command:
  [`vyre vault`](../reference/cli.md#vyre-vault), or `vyre vault help`.
