---
title: ADR 0010: Vault autofill
summary: How the Vault fills a login into a browser page, the one path where a value reaches a screen, while staying shut to agents, web pages and stolen browser profiles.
audience: builders
owner: docs
status: stable
---

# ADR 0010: Vault autofill

Status: accepted, 26 Sep 2026 · Workstream: vault · Extends: ADR 0001, decisions 6 and 10 · Code:
`core/vault/fill.js`, `modules/vault-extension/`

## The problem

To replace a password manager, the Vault has to put a login into a browser page. That is the
one path where a value is meant to reach a screen, so it needs its own door. The door must stay
shut to three callers: agents, web pages, and anyone who holds only a stolen browser profile.

Decision 10 of ADR 0001 sketched `vault.match` and `vault.fill`. This addendum settles how they
work.

## Threat model

Defended:

- **An agent asking for a login.** No registry tool fills. `vault.fill` is a route on a separate
  listener, not a tool, so Claude and modules are never offered it and cannot call it.
- **A web page calling the listener from script.** Browsers attach an `Origin` header to
  cross-origin requests. The listener refuses any request whose `Origin` is present and is not
  `chrome-extension://<id>` or `moz-extension://<id>`, and it does so before it reads the body.
  CORS is answered only for the extension origin that asked. A page also has no device token,
  and it would need one even without the Origin rule.
- **Phishing.** A login fills a page only when the page's origin is one of the login's hosts,
  compared exactly on scheme, host and port. A login for `https://mail.example.com` is never
  filled into `https://mail.example.com.evil.test`, `http://mail.example.com` or
  `https://mail.example.com:8443`. `match` applies the same rule, so the popup offers only what
  will fill. The content script checks `location.origin` again before it sets a field, in case
  the tab moved between the click and the fill.
- **A stolen browser profile.** The device token in `chrome.storage.local` lists login names for
  a page and nothing more. A value needs a session. The session token lives in memory and
  `chrome.storage.session`, both cleared when the browser closes, and it ends after 10 minutes
  idle or 12 hours at most.
- **Guessing the unlock passphrase with a stolen device token.** 5 wrong passphrases from a
  device within 15 minutes lock that device out for the rest of the window, even from the right
  passphrase. The verifier is scrypt (N=2^17, r=8, p=1), as for the vault key.
- **Guessing a pairing code.** A code is 8 characters from a 31-letter alphabet with no 0, O, 1,
  I or L. It works once, for 5 minutes. 10 wrong codes in 15 minutes stop all pairing for the rest
  of the window.
- **Reading tokens out of vyre.db.** Every module can read vyre.db. Device and session tokens are
  32 random bytes stored as sha256, which a reader cannot reverse. Pairing codes are too short
  for that, so they are stored as HMAC-SHA256 under a key held only in vyred's memory. A restart
  voids codes nobody has used yet.
- **A leaked audit trail.** Pairing, each unlock (ok or refused), each fill (ok or refused),
  lock and revoke are audit rows carrying names only, with `who` set to `device:<id>:<name>`. No
  value, token, code or passphrase is ever written to an audit row, an event, an error or a log.

Not defended, stated plainly:

- **A module that writes to vyre.db.** It could add a device row or replace the unlock verifier.
  `vault_grants` carries the same exposure today, and the answer is the same: run vyred as its
  own user and install only modules you trust. A later change can MAC these rows under a key
  derived from the master key.
- **Malware in the browser or the extension's own process.** It sees what the page sees once a
  field is filled, as it does with any password manager.
- **The person filling a login into a page on the right origin that is itself compromised.**
  The origin rule stops a lookalike host. It cannot stop an XSS on the real one.

## Decisions

### A1. A separate listener, owned by the vault module

Config: `vault.fill: { host = "127.0.0.1", port }`. It follows the relay listener's shape: its own
HTTP server, JSON in and out, `{data}` or `{error: {code, message}}`, and a 64 KB body cap. On a
box it sits behind `tailscale serve`, which gives the extension an `https://*.ts.net` address. It
serves these routes and nothing else:

| Route | Credentials | Body | Answer |
|---|---|---|---|
| `POST /v1/fill/pair` | none | `{code, name}` | `{device, name, token}` |
| `POST /v1/fill/unlock` | device | `{passphrase}` | `{session, expires}` |
| `POST /v1/fill/lock` | device | `{}` | `{locked, sessionsEnded}` |
| `POST /v1/fill/match` | device | `{url}` | `{origin, logins: [{name, description, url}]}` |
| `POST /v1/fill/fill` | device + session | `{name, url}` | `{username, password, totp?}` |
| `GET /v1/fill/status` | device, session optional | | `{device, canUnlock, unlocked, expires?, session?}` |

The device token goes in `Authorization: Bearer <token>`, the session in `X-Vyre-Session`.
Requests without an `Origin` (curl, tests) are allowed and still need both tokens.

Error codes: `origin_refused` (403), `unauthorized` and `revoked` (401), `bad_code` (403),
`bad_passphrase` (401), `locked_out` (429), `not_set` (409, no unlock passphrase yet),
`session_required` and `session_expired` (401), `wrong_origin` (403), `not_found` (404),
`vault_locked` (423), `too_large` (413).

### A2. Pairing

`vyre vault pair` calls `vault.device.code {name?}` and prints the code. The extension posts it
to `pair` and receives a device id and a device token: 32 random bytes in base64url, stored as
sha256 in `vault_devices`. `vault.devices` lists devices by name, when each was last seen and how
many sessions it holds. `vault.device.revoke {id}` ends a device at once, sessions included.

### A3. Unlock and sessions

A device token alone never reveals a value. `unlock {passphrase}` opens a session: a second
32-byte token, stored as sha256 in `vault_sessions`, bound to that device, ending after 10
minutes without a fill or 12 hours after it opened, whichever is first.

The passphrase is the **unlock passphrase**, set with `vault.unlock-passphrase {passphrase}` and
kept as a scrypt verifier in `vault_meta` under the key `unlock`. It is separate from the vault
key so that a box on the keychain or file keystore, which unlocks itself for agents, still asks a
person before a browser gets a value. Changing it ends every session. When the keystore is
`passphrase`, the vault passphrase is also accepted, checked through the keystore by a callback
the module passes in.

**Touch ID.** The Capsule helper runs Touch ID and then calls `vault.device.unlock {device}`,
which opens a session and returns only `{ok, expires}`. The session token waits in vyred's memory
and is handed to that device once, on its next `status` call. No token crosses the socket, and a
token nobody collects dies with the session.

### A4. Who may call what

The table of decision 6 gains these rows:

| Tool | cli / local | mcp | module |
|---|---|---|---|
| `vault.device.code`, `vault.device.unlock`, `vault.unlock-passphrase` | yes | refused | refused |
| `vault.devices`, `vault.device.revoke` | yes | yes | yes |
| fill | not a tool | not a tool | not a tool |

Giving access needs a person; taking it away never does, as before.

### A5. The extension

`modules/vault-extension/` is a Chrome MV3 extension in plain JavaScript with no build step and
no remote code. Its permissions are `storage`, `activeTab` and `scripting`. Its only host
permission is the vyred address (default `http://127.0.0.1/*`; `localhost` and `*.ts.net` are
optional and requested when the person saves one). A strict CSP limits `connect-src` to those
addresses, so the extension cannot reach anything else.

- The background worker is the only part that talks to vyred. It sends the page's origin, never
  its path, query or content.
- The popup never holds a password. It asks the worker to fill a login by name.
- On **Fill**, the worker injects `fill.js` into the active tab's top frame with
  `chrome.scripting.executeScript`. The script sets the username, password and one-time-code
  inputs through the native value setter, dispatches `input` and `change`, and returns only the
  kinds of field it filled.
- No content script runs on any page until the person clicks.

## Consequences

- A paired browser is useless on its own: a thief also needs the unlock passphrase within five
  tries, or the person's finger on the Mac.
- A person unlocks at most every 10 minutes of use, and twice a day at most.
- Lookalike-domain phishing fails closed. A site that moved to a new origin needs its login put
  again with the new host, which is the price of exact matching.
- The existing `vault.match` tool keeps its looser hostname rule for local clients. The fill
  listener does not use it.
