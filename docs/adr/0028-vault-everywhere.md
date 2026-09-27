---
title: ADR 0028: The Vault everywhere: import, agent logins, rotation and autofill on every device
summary: How the Vault fills day one from another password manager, lends one login to one agent for one site with a log of every use, reminds a person to rotate through the planner, and fills through each operating system's own autofill on iPhone, iPad, Android, the Mac, the browsers and agent computers.
audience: builders
owner: docs
status: stable
---

# ADR 0028: The Vault everywhere

Status: proposed, 27 Sep 2026 · Workstream: vault-next · Extends: ADR 0001, 0006 and 0010 ·
Depends on: ADR 0004 (presence), ADR 0018 (mobile), ADR 0012 (the CDP proxy), ADR 0025 (planner)

## Why

The user wants to cancel their password manager. Four things stand in the way. The Vault is
empty on day one. It fills only in Chrome and the Capsule. Agents can use an item only through a
grant to a whole module. Watchtower finds weak and breached passwords, but nothing tells the
person to fix them. The user's words for autofill are "invisible and everywhere":

- Every fill goes through the operating system's own autofill UI. Vyre adds no popup of its own.
- A fill costs one Face ID or Touch ID tap, or none while a presence window is fresh.
- Nothing leaves the box or the device unencrypted.
- Agents never see plaintext.
- Every fill is logged.

## What already exists

These were built under ADRs 0001, 0006 and 0010 and are not rebuilt here:

- Import from `.env`, 1Password CSV and `.1pux`, Bitwarden CSV and JSON, Chrome CSV and Safari
  CSV (`core/vault/import.js`). Duplicates are found by name only.
- Watchtower (`health.js`), which marks items weak, reused, old, rotate or 2fa-available. It also
  runs the opt-in k-anonymity breach check against the HIBP range API.
- The fill listener, pairing, sessions and the Chrome MV3 extension (`fill.js`,
  `modules/vault-extension/`).
- The Capsule's native fill (`native.js`, `mac/type.swift`).
- Presence sessions: 30 minutes at most and 5 minutes idle, for reveal, copy and totp
  (`core/presence`).
- Multi-device join, which seals the account keyset to a new device (`devices.js`), and item sync
  over `/v1/sync`.

## Threat model

These are added to the lists in ADR 0001, 0006 and 0010.

Defended:

- **An agent reading a login it was lent.** An agent grant lets the agent use a login. It never
  lets the agent read one. vyred puts the value into the agent's computer itself (decision 3),
  and no tool returns it to an agent.
- **An agent using a grant somewhere else.** A grant names exactly one agent, one login and one
  origin (scheme, host and port). vyred checks the origin of the page it is filling, on its own
  CDP connection, and ignores whatever the agent claims the origin is.
- **An agent that planted code in the page, or recorded the network, before the fill.** vyred
  fills in a fresh browser context: no service workers, no extensions and no scripts from the
  agent. It drops the agent's CDP connections for the length of the fill, so `Network` and
  `Runtime` cannot watch the request that carries the password. The agent gets the page back
  after the login has navigated away.
- **A phishing page in any app.** Every platform matches exact origins, as ADR 0010 does.
  - iOS and macOS pass the service identifier (the domain or URL) to the provider, and the
    provider refuses anything that doesn't match exactly.
  - Android passes the web domain from the view structure, or the app's package plus its signing
    certificate. A native app fills a login only when the login lists that app, as `meta.apps`
    does for the Capsule. Android package names are matched together with their certificate
    digest (`android:<pkg>@<sha256>`), because a package name alone is spoofable.
- **A stolen, unlocked phone.** Its replica of the vault opens only through a Secure Enclave or
  StrongBox key that needs Face ID or a fingerprint. The presence window closes when the phone
  locks.
- **A copied import file lingering.** The file is read by vyred and never copied. Preview returns
  names and counts only. The result tells the person to delete the file.
- **The breach check leaking a password.** Only the first five hex characters of a SHA-1 go out,
  with `Add-Padding: true`. The check stays opt-in.
- **Logs.** Every fill, agent use, grant, revoke, import and reminder is an audit row and an
  event carrying names, origins and counts. Neither ever carries a value, a hash of a value, a
  length or a username.

Not defended, stated plainly:

- **The operating system's autofill store holds usernames.** For a login to appear in the
  QuickType bar or the Android suggestion strip, the OS must know `(domain, username)` before
  anyone unlocks. This is the one place a username sits outside the seal. It stays on the device,
  in storage the OS protects. The setting `vault.autofill.identities: "usernames" | "names"`
  shows the item name in place of the username, and the default is usernames. Passwords are
  never put in the OS store.
- **An agent with a shell in its own computer.** It could read the browser's memory while a fill
  is in flight, or the cookies afterwards. Cookies are the point of lending a login. For memory,
  decision 3 needs computerd to run Chrome as a different uid from the agent's exec user, with
  ptrace blocked. A lent login is a trust decision per site. When a site has an API, a relayed
  pass is the better tool.
- **The site itself.** A compromised origin can read what it is given, as in ADR 0010.
- **An extension that is not Vyre's.** It runs in the same page as the password.

## Decisions

### 1. Import: a preview, duplicates by content, and Apple Passwords

- `vault.import.preview {file, format?}` goes through the same presence as import, because it
  opens the file. It reads and parses the file and returns:

  ```
  { format, token, counts: {login, note, card, secret, api-key},
    add: [name], same: [name], conflicts: [{name, existing}], renamed: [{from, to}], skipped: [reason] }
  ```

  `token` binds the preview to the file's SHA-256 and its size. `vault.import {file, token?,
  conflicts?: "skip"|"update"}` refuses a token that no longer matches the file. What gets
  imported is exactly what was previewed.
- Duplicates are judged by content, not only by name. vyred opens the existing logins, since the
  personal vault is open during the import presence. It keys each login on its origin plus its
  username.
  - `same`: the origin, username and password all match. The row is skipped silently.
  - `conflicts`: the origin and username match but the password differs. The default is to skip.
    `update` makes a new version, so the old password stays in history.
  - A different login whose name is already taken gets `-2`, `-3` and so on, listed under
    `renamed`.
- Apple Passwords (macOS 15 and iOS 18) exports `Title,URL,Username,Password,Notes,OTPAuth`, the
  same header as Safari. The format is reported as `apple-csv`, and `safari-csv` stays as an
  alias.
- `.env` files, one or a folder of them, go through the same two tools. Each file is one `env-set`
  named after its path, holding only the variables `detect.js` calls secret; plain config stays in
  the file. The preview adds `files: [{file, item, state, vars: [{key, secret, type, provider?,
  mode?, public?, expires?}], kept, git?: {tracked, ignored}}]` and `templates`. A type and a
  provider are words from a fixed list, never a slice of the value. The token covers every file's
  path and bytes. `vault.import {rewrite: true}` then replaces each stored variable's line with
  `KEY=vault://item/KEY`, only in files whose values are all in the vault, atomically, with no
  backup. `vyre run -- cmd` reads the result.
- Surfaces: the CLI (`vyre vault import --preview`, `--rewrite`) and the Deck's import sheet (the
  pwa team's surface). Both call these tools.

- Sources beyond 1Password, Bitwarden, Chrome and Apple (core/vault/import-more.js): LastPass,
  Dashlane, Keeper, NordPass, Proton Pass, Enpass, KeePass/KeePassXC XML and CSV, Firefox, and the
  Chromium browsers' CSV. Encrypted exports (a .kdbx, a PGP Proton export) are refused with how
  to export again. The XML reader refuses any DOCTYPE, so no entity can expand.

### 1b. Typed credentials

- Kinds (core/vault/kinds.js, the one list every surface reads): login, authenticator, passkey,
  card, address, identity, note, api-key, pat, oauth, cloud, db-url, secret, env-set, ssh-key,
  cert, recovery-codes, wifi, license, file. Each kind names the fields it needs and the field it
  hands over when a reference names none (`vault://kit-github` is the PAT's token).
- Personal kinds (login, authenticator, passkey, card, address, identity, note, recovery-codes,
  wifi, license) start in the personal vault once there is an account. A grant still moves an item
  to the agent vault, as before.
- A passkey, like an ssh-key, is never released, injected, revealed or copied. It signs inside
  vyred (decision 7, later).
- `details` is a new column: `expires`, `scope`, `provider`, `issuer`, `ssid`, `product`,
  `filename`, `count`, `rp`. Each has a fixed shape and nothing else is accepted. Details are
  listable and never decide where a value may go, so they are neither sealed nor MACed. A module
  that edits vyre.db can hide an expiry reminder and no more. Some details are derived from the
  fields: a certificate's end date, an authenticator's issuer, the count of recovery codes, a
  network name. Details the caller leaves out are kept across puts, and they ride in backups.
- Watchtower adds `expired` and `expiring` (within 14 days). Reuse also counts the value a typed
  credential hands over. Decision 4's daily job turns both into planner todos.

### 1c. The authenticator

- `vault.codes {names?}` (people's surfaces, presence, rides the 30-minute window) returns every
  item with a seed: `{name, kind, issuer?, code, next, period, remaining, digits}`. Never a seed.
  `vault.totp` adds `next`. The client counts down from `remaining` and asks again at the
  rollover, only while the list is on screen (principle 8).
- `vault.codes.import {uris, preview?}` takes scanned text: Google Authenticator's
  `otpauth-migration://offline` parts (protobuf, decoded in core/vault/otpmigration.js) and
  `otpauth://totp/` links. Parts of one export share a batch id; the import refuses until every
  part is there and says which to scan. A seed already in the vault (compared by algorithm,
  digits, period and bytes) is `same`. New accounts are `authenticator` items named after the
  issuer and label. The QR image is read on the client (camera, BarcodeDetector, Vision), so
  vyred only sees text, and Claude never does: the tool is not offered to mcp.

### 2. Agent logins: one agent, one login, one origin

A new table, MACed like the other grant rows:

```
vault_agent_grants(id, item, agent, origin, expires, by, at, revoked, mac, UNIQUE(item, agent, origin))
```

- `vault.agent.grant {agent, item, origin, expires?}` needs presence, with the summary "Let kit
  sign in to https://app.northwind.test as harlow-drive until 1 Oct". From mcp it waits as
  pending until `vault.approve`, like `vault.grant`. The origin must be one of the login's hosts.
- `vault.agent.grants {agent?, item?}` lists grants, active and revoked, with the last use and a
  use count. `vault.agent.revoke {id}` needs no presence, since taking access away never does.
- `vault.uses {item?, agent?, since?, limit?}` is the log of every use. It is built from audit
  rows: when, which item, which agent or device, which origin, which surface
  (`ios | android | mac | chrome | firefox | capsule | computer`), and the outcome. It is shown
  on the Deck (item pane: "Used by", and a Grants place in the rail) and in the phone app.
- An agent uses a grant only through `vault.agent.fill` (decision 3). There is no agent tool that
  returns a login field.
- The existing module grants (`vault.grant` to `agents` with `needs.vault: ["per-agent"]`) stay
  for API keys handed to an agent's environment. Agent logins are the new path for anything a
  browser signs into.

### 3. Filling an agent's computer

`vault.agent.fill {item}` is callable by a vouched agent caller (`agent:<name>`, checked by
`threads.vouch`). It fills the agent's own computer and never another agent's. The steps:

1. vyred checks for an active grant for `(item, agent)` and reads the origin it names.
2. It asks computers (`computers.fill.begin`, internal, owned by the computers workstream) to
   raise the shield and close the agent's CDP sessions. vyred then gets a CDP endpoint of its
   own, through computerd with a short-lived token.
3. It opens the grant's origin in a new browser context (`Target.createBrowserContext`), checks
   that the page's origin equals the grant's origin, and finds the username, password and
   one-time-code fields through the DOM.
4. It sets each field with `Input.insertText` on the focused field, never through
   `Runtime.evaluate` with the value in the script, and submits.
5. It waits for a navigation or 20 seconds, whichever comes first, then clears any password
   field left in the DOM and closes its CDP session.
6. `computers.fill.end` lowers the shield and hands the context's target to the agent, whose
   cookies are now signed in.

The agent receives `{filled: ["username","password"], origin, navigated}`. Every step is audited.
A fill refused because the origin differs says which origin it saw, never a field.

Needs from computers: `computers.fill.begin/end` (internal), Chrome under its own uid, ptrace
blocked, and computerd closing agent CDP websockets on `begin`.

### 4. Rotation reminders through the planner

- A daily job, kept light (principle 8): one run, the earliest after 09:00 local, never more
  often. It runs Watchtower. If `vault.breach` is `weekly`, it also runs the breach check once a
  week. `ask` stays the default, and the person turns on `weekly` from the Watchtower screen.
- For every item that is `breached`, `reused`, `old` or `rotate`, and that has no open reminder,
  it calls `planner.add`:

  ```
  { kind: "todo", title: "Change the password for harlow-drive", list: "Vault",
    tags: ["vault", "rotate", "<reason>"], priority: breached ? 1 : 2, due: <today + 3d if breached, else + 14d> }
  ```

  It keeps the planner id in `vault_marks` so it never adds the same reminder twice. When more
  than 5 reminders are new in a run, it makes one todo ("Change 12 passwords: reused") whose body
  lists the names, so the planner stays usable.
- A later put of the item marks the planner item done (`planner.done`). If the person dismisses
  the reminder, it is not raised again for the same reason until the reason changes.
- The planner is reached through `ctx.call`. If `planner.add` does not exist yet, nothing
  happens, and Watchtower still shows the list.

### 4b. Built (27 Sep 2026)

- The daily job is core/vault/remind.js. It is one setTimeout, re-armed after each run for the
  first 09:00 after the last one, or a minute from now when that has passed. It runs on the box.
  A Mac runs it only when it is not paired with a box (link.status), so nobody is told twice.
  Reasons that raise todos: expired, breached, expiring, rotate, reused, old. The marks live in
  `vault_reminders(name, reason, planner, state)`, which is not MACed: a mark only silences a
  todo. `vault.remind.run` runs the pass now. The weekly breach check waits on an unattended
  way to open personal logins, so it still runs only when a person asks.
- The leak sweep is `vault.sweep {path, history?, shell?}` (core/vault/sweep.js). It needs
  presence, because it opens every value. Values are compared in memory and nothing goes to a
  temp file. It returns places and names only, and never a line of context.
- Rotation is `vault.rotate {name}` (core/vault/rotate.js, tools/rotate.js). It is automatic for
  AWS IAM keys (SigV4), GitLab PATs (self/rotate), Cloudflare user API tokens (roll) and Google
  Cloud service-account keys. Everything else is guided, with the provider's page and steps.
  The new credential is stored as a new version BEFORE the old one is revoked. `vault.rotation
  {name}` says which way an item rotates. Twilio stays guided: Standard API keys cannot manage
  keys.

### 4c. Decided by the lead (27 Sep 2026)

- Rotation has only been tested against fake providers. Until it is proven against a real
  account, revoking the old key is the one step that asks for proof, with the new key's name
  shown. Storing the new key needs no proof. (Not built yet: today vault.rotate asks once for the
  whole rotation.)
- References: `vault://item/field` is the only scheme. `vyre://` stays for app deep links.
- The iOS/macOS extension keeps its session token in the shared Keychain group for 30 minutes,
  cleared on device lock, matching the presence session.
- Agent grants must name a project (ADR 0031): a nullable `project` column on
  vault_agent_grants, checked on every use, and revoked by project when a teammate is unshared.
  Not built yet.
- The extension should sign each request with a paired key (e2e 628e2cd9: `x-vyre-proof`), and
  the key becomes required once it ships. Not built yet.

### 5. The presence window for fills

The standing rule is one proof for about 30 minutes on the Deck, the Capsule and the phone. The
CLI gets a fresh proof every time, which polish-cli is building. Applied to fills:

- A fill session opens with any presence proof: Touch ID, the Capsule's signature, a passkey, or
  a phone's device key (ADR 0018). It lasts 30 minutes from the proof. It does not extend with
  use, and it closes on sleep, on screen lock, or when the device locks. The ADR 0010 unlock
  passphrase is kept only for a browser on a machine with no Touch ID.
- On a phone the window lives on the phone. The provider extension asks for Face ID when the
  window is closed. Inside the window it fills without asking, through
  `provideCredentialWithoutUserInteraction`.
- An item marked `reprompt` (cards by default) always asks.

### 6. Autofill per platform

| Platform | Mechanism | Where the value comes from | The one tap |
|---|---|---|---|
| iPhone, iPad | `VyreAutofill` app extension (`ASCredentialProviderViewController`): passwords, one-time codes (iOS 18), passkeys (iOS 17, `ASPasskeyCredentialRequest`). `ASCredentialIdentityStore` holds `(domain, username, recordIdentifier)` | A local replica of the personal vault on the phone, which joins as a full device through `devices.js`. The personal VK is wrapped by a Secure Enclave key with `.biometryCurrentSet`, in the app group container shared by the app and the extension. Sync is `/v1/sync` through the box, which holds only ciphertext | Face ID in the system sheet, or none inside the window |
| Android | `AutofillService` (every app and browser that supports autofill) plus `CredentialProviderService` (Android 14 and later: passwords and passkeys in Credential Manager) | The same replica, with the VK wrapped by a StrongBox or TEE key that requires biometrics | `BiometricPrompt`, or none inside the window |
| Mac: Safari and native apps | A credential provider app extension (`ASCredentialProviderViewController`, macOS 14 and later) inside the native Capsule app, target `sh.vyre.capsule.autofill` | The local vyred, over the loopback fill listener. The device token is in the Capsule's keychain access group | Touch ID in the system sheet, or none inside the window |
| Mac: Capsule ⌘K | The existing `vault.fill.native` | The local vyred | The Capsule's signed presence |
| Chrome, Arc, Edge, Brave | The MV3 extension. Chrome gives extensions no access to its own autofill dropdown, so a small inline chooser in a closed shadow root is the one Vyre UI | The local vyred, or the box's fill listener behind `tailscale serve`, for agent-vault items only | Touch ID through the Capsule helper, or none inside the window |
| Firefox | The same extension with `browser_specific_settings`. The worker becomes an event page | Same | Same |
| Agent computers | Decision 3 | vyred | None: the grant is the person's consent |

Passkeys are a new `passkey` kind: a P-256 private key, the RP id, the user handle and the
credential id, all sealed. The device whose vault is open makes the assertion. The key can be
exported so it syncs across the person's devices, as synced passkeys do everywhere else. The
browser extension's passkey support (a MAIN-world `navigator.credentials` shim) comes last.

Signing is a blocker. Credential provider extensions on iOS and macOS need the AutoFill
Credential Provider entitlement, which comes with a provisioning profile from a paid Apple
Developer team. The Capsule is ad-hoc signed today, and the Developer ID is about a month away.
Until then the iOS extension is built and tested in the simulator on GitHub Actions, and the
macOS extension is built but not installed. Android has no such gate.

### 7. Passkeys in vyred and the extension (built 27 Sep 2026)

- core/vault/webauthn.js is the authenticator. It supports ES256 only, `attestation: "none"` with
  the Vyre AAGUID 9700b56e-127f-445c-a7ca-560431cc2b48, and the flags UP, UV, BE and BS (a synced
  passkey, so the counter stays 0). rpIdAllowed() refuses public suffixes, IP literals, http off
  localhost, and any rpId the origin may not claim.
- The fill listener gains `passkeys` (a device token, names only), `passkey.create` and
  `passkey.get` (a device token plus a live session, the same window as a password fill). The
  worker sends the frame's origin from the sender. A new passkey is a `passkey` item named after
  the rpId and the account, with `details.rp` and `details.credential` listable. The private key
  never leaves vyred: release, inject, reveal and copy all refuse it.
- The extension (passkey-page.js in the MAIN world, passkey-bridge.js isolated) takes over only
  `publicKey` create/get that Vyre can serve. It asks in a closed shadow root and acts only on
  trusted clicks. It falls back to the browser's own authenticator when not paired, unreachable,
  asked to, under conditional mediation, or when the parent's permissions policy forbids it.
  Firefox 128 or later.
- Still to come: conditional mediation (Vyre passkeys in the browser's autofill list), the
  prf/largeBlob extensions, the Android Credential Manager provider, and the iOS/macOS providers
  (simulator and CI only until there is an Apple Developer team).

### 8. Emergency access (built 27 Sep 2026)

A verified contact can reach the owner's items after a waiting period the owner can stop.
core/vault/emergency.js holds both sides.

- `vault.emergency.add {person, wait?, items?}`, person present. The person must be pinned and
  verified by fingerprint in share.js; a card that was only pinned, or whose key changed, is
  refused. The wait is 1d to 30d, 7d by default. Items default to every agent and personal item
  except `ssh-key` and `passkey`.
- The vault builds the sealed-pass ticket for that person with the same code a sealed pass uses
  (`Vault.ticketFor`, factored out of `issue`), then escrows it: the ticket bytes under a fresh
  random 32-byte key with AES-256-GCM (aad `vyre:emergency:v1:<id>`) in
  `<vault>/emergency/<id>.bin`, mode 0600, and the key sealed in the agent vault as an internal
  record (`emk_<id>`, bound to the grant's MACed refresh time), not an item. The box alone holds
  ciphertext sealed to the contact's key; the contact alone has no ticket.
- `vault_emergency(id, person, wait_ms, items, created, refreshed, requested, denied, released,
  removed, mac)` is MACed like the other grant rows.
- Refresh: `vault.emergency.refresh` (person present), and on every account unlock for grants not
  refreshed in the last day and not yet released. A refresh never changes the request state.
- The contact runs `vault.emergency.request {owner}` and `vault.emergency.status {owner}`, both
  person present. Each sends an envelope signed with the contact's device key under the tag
  `vyre:emergency:v1` (audience, timestamp and nonce, as a sync envelope) to the owner's relay
  listener at `POST /v1/emergency`.
- The listener finds the sender by the signing key among verified people with live emergency
  access; anyone else gets the unknown-pass refusal and at most one audit row a minute. A
  `request` with none open sets `requested`, emits `vault.emergency-requested {person, opens}`,
  writes an audit row and adds a planner todo in the Vault list. A `status` after
  `requested + wait`, not denied or removed, opens the escrow, checks the ticket is for the
  sender's key, sets `released`, and returns the ticket; before that it returns the state and
  when it opens. The contact's side accepts the ticket through `accept()`, so the items land as
  a sealed pass's do.
- `vault.emergency.deny` (closes the request, or a release, and sets `denied`),
  `vault.emergency.remove` (deletes the escrow and the key record) and `vault.emergency.list`
  need no presence: taking access away never does. `vault.offboard` removes emergency access too.
- Audit rows, events and todos carry names, the wait and dates. Never a value, the escrow key or
  the ticket.

### 9. Connections: every key goes in through the Vault (27 Sep 2026)

The user: every key the system needs, at any point, is set up through the Vault, and one place,
"Vault, Connections", shows every connection and which surface may use it. Today the Capsule says
"Run: vyre voice key", each module has its own way in, and nothing lists a person's four email
accounts side by side.

**9a. A module says what it needs; it never asks for a key itself.** A manifest adds
`needs.credentials`, a list of `{id, kind, provider, purpose, item?, optional?, group?}`. `kind` is
a kinds.js kind, `provider` a name in the provider catalog (core/vault/providers.js), `item` the
vault item it fetches (default `<module>-<id>`), and `group` joins alternatives (voice: one of
Deepgram, OpenAI or ElevenLabs). The module validator checks the shape; `ctx.vault.fetch`
accepts these items as it accepts `needs.vault` names.

- `vault.need {module?}` (people's surfaces, no presence) returns each need with its state:
  `ready`, `missing`, `not_granted`, `pending` (an mcp grant waiting), `expired`, and how to fill
  it: `{how: "field" | "file" | "oauth", fields: [{name, label, secret}], help, next?}`. It never
  returns a value. A group is ready when any member is.
- `vault.connect {module, need, fields? | file? , label?}` (people's surfaces, presence) checks
  the fields against the catalog, puts the item with its kind and `details.provider`, grants it to
  the module, and records the connection (9b). `how: "file"` takes a dropped service-account JSON;
  `how: "oauth"` returns `next: {tool, input}` (for Google, `google.connect`), since the module
  that owns the flow runs it. The Capsule shows a secure inline field, the Deck and the phone a
  sheet, the CLI a hidden prompt (`vyre vault connect voice`). All four call the same two tools.
  `vyre voice key` stays, as a shortcut for `vault.connect {module: "voice"}`.

**9b. A connection is a provider, an account, an auth kind, capabilities and surfaces.** Table
`vault_connections(id, source, ref, provider, account, auth, label, capabilities, surfaces,
added, updated, mac)`, MACed like the grant rows, unique on `(source, ref)`. A row whose MAC
fails is granted to no surface. Ids are `cn_` and base64url, stable across upserts. Rows come
in two ways, and both stay:

- `vault`: an item made by `vault.connect` or put with a catalog provider (API keys, PATs, IMAP
  and SMTP logins, Apps Script web-app tokens). The vault writes these itself and resyncs them on
  `vault.connected` and on its own put and delete events. Nothing polls.
- `google` and `mcp`, read by the vault through their own read-only tools (`google.accounts`;
  `mcp.servers` with the cached `mcp.tools`), never their tables, and resynced on their events
  (`google.added`, `google.removed`, `google.connected`, `mcp.added`, `mcp.updated`,
  `mcp.removed`, `mcp.refreshed`) and on first read after start. `ref` is the account name or
  the server name. A row leaves when its account or server does; a module that is not running is
  an empty source.
- A module's own rows. `vault.connections.register {ref, provider, account, auth, label?, capabilities? | tools?,
  items?, use?}` (module callers only) upserts on `(source, ref)`, where `source` is the calling
  module's name from its caller label, never from the input, and returns `{id}`. `auth` is one of
  `oauth`, `service-account`, `api-key`, `password`, `bearer`, `none`. With `tools` and no
  `capabilities`, capabilities come from the tool names by a small pattern table (`gmail_send`
  sends mail; `search_threads` reads mail on a mail server; `list_events` is calendar).
  `vault.connections.unregister {ref}` removes one of the caller's own rows. A registered row is
  the module's: a sync of the same source neither changes nor removes it. Two Gmail servers are
  two rows either way.
- `items` names the vault items a row signs in with. A row whose items are not all there and
  granted to its module has state `needs_credential`, with `needs: [{module, need}]` from that
  module's manifest. An item a module row claims is not listed again as a vault row.

Capabilities are `send_mail`, `read_mail`, `calendar`, `files`, `send_message`, `speech`, `llm`,
`search` and `other`; a person may change them and the label (`vault.connections.update`), and
the change survives every resync and re-register. `use` is a map from capability to
`{tool, input}`: what a module passed, the catalog for vault rows, and for `send_mail` and
`read_mail` with nothing else, `mail.send` and `mail.search` with `{account: <connection id>}`.

- Surfaces: `capsule`, `chat`, `agents`, `phone`. A new connection is granted to `capsule` and
  `chat`; `agents` is opt-in. The caller decides the surface: `capsule`, `mobile` (phone),
  `mcp` and `mcp:thread:<id>` (chat, or capsule when the thread's purpose is `capsule`),
  `mcp:agent:<n>` and `tailnet:agent:<n>` (agents). `cli`, `local`, `deck` and the owner's own
  device at the box's tailnet address are the person at a settings screen and see everything.
- `vault.connections.list {capability?, surface?, caller?}` (people's surfaces, mcp and modules)
  returns only the rows granted to the caller's surface, each with `uses`, and with a capability
  also `use`, that one entry. A module must pass `surface`, or `caller` (the caller it acts for).
  So "send an email" in the Capsule offers every account that can send, and Claude in a chat
  thread sees the same list. Never a value, a token or a field name that holds one.
  `vault.connections.get {id}` (modules only) is one row's metadata for the module that acts on
  it: a row of its own source, or one whose `use` names one of its tools (so `mail` reads a row
  that routes to `mail.send`, as mail.release does after the Gate approved). Any other row, a row
  that fails its check and an id that is not there all answer the same `not_found`.
- `vault.connections.grant {id, surface}` (presence), `vault.connections.revoke {id, surface}`
  (no presence: taking access away never needs it), `vault.connections.sync` (people).
- `vault.connections.allowed {id} | {source, ref}, caller` (modules only) returns
  `{allowed, surface, reason?}`: the check a module makes before it acts on a connection. People
  are always allowed; a module acting as itself is not a surface and must pass the caller it acts
  for. A send is still held at the Gate as before; the grant decides who may ask.
- A module that cannot act because a credential is missing answers with one shape,
  `{code: "needs_credential", message, detail: {module, need, account?}}` (the kernel helper
  core/modules/needs-credential.js), so every surface offers the same fix, `vault.connect`.
- Events: `vault.connection-added {id, source, provider, account}`,
  `vault.connection-removed {id}`, `vault.connection-changed {id, fields}`.
- A need may take several accounts: `multiple: true` in `needs.credentials`, and `vault.connect`
  then takes a `label` and names the item `<module>-<label>` (mail-northwind, say).

**9c. IMAP and SMTP.** The connectors team owns a module `mail` (core/mail, under ADR 0016) with
`mail.test`, `mail.search`, `mail.read`, `mail.send` and `mail.release` over IMAP4rev1 and SMTP
(TLS or STARTTLS, AUTH PLAIN or LOGIN), with no new dependency. A login is an `env-set` item of
provider `imap-smtp` granted to `mail`, declared as the need `{id: "imap", kind: "env-set",
provider: "imap-smtp", multiple: true}`, and an Apps Script web app as `{id: "apps-script", kind:
"env-set", provider: "google-apps-script", multiple: true}`. The mail module registers nothing:
each login is a vault row. The mail tools take `account`, a connection id of any source whose
capabilities include mail; they ask `vault.connections.allowed` first. `mail.send` offers
`mail:<account>` to the Gate and releases through `mail.release`, as google does. Tests run
against fake IMAP and SMTP servers only.

**9d. What is not in this step.** Apps Script web apps are saved and listed (`url` and `token`,
capabilities the person picks) but have no adapter yet: each script's shape is its own. OAuth for
providers other than Google waits for a module that runs the flow. The Deck and phone sheets are
pwa's and mobile's; the Capsule's inline field is capsule-pro's; the settings hub entry
"Vault, Connections" is native-core's.

## Order of work

1. This ADR.
2. Import: preview, duplicates by content, `apple-csv`, and the CLI.
3. Agent grants, `vault.uses`, and the Deck rows through pwa.
4. Rotation reminders through the planner.
5. The fill window (decision 5) and the Firefox and Arc build of the extension.
6. Filling agent computers, with the computers workstream.
7. The Android AutofillService and CredentialProviderService, built on GitHub Actions.
8. The iOS extension, with mobile, built on GitHub Actions.
9. The macOS extension, with capsule-pro, after the Apple team is in place.
10. Passkeys.
11. Connections (decision 9): the needs contract, the connections table and tools, the mail module,
    then the surfaces through their owners.

## Consequences

- The Vault is full on day one, and the person sees exactly what will change before it changes.
- An agent can sign in to one site as the person without ever holding the password. The person
  can see every such use and end it in one click.
- Autofill on phones needs the phone to hold the personal vault, encrypted, which is what every
  password manager does. The box still cannot open a personal login.
- iOS and macOS autofill cannot ship until the Apple team exists.
