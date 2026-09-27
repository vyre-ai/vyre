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

## Consequences

- The Vault is full on day one, and the person sees exactly what will change before it changes.
- An agent can sign in to one site as the person without ever holding the password. The person
  can see every such use and end it in one click.
- Autofill on phones needs the phone to hold the personal vault, encrypted, which is what every
  password manager does. The box still cannot open a personal login.
- iOS and macOS autofill cannot ship until the Apple team exists.
