# ADR 0001 · How the Vault seals, releases and shares credentials

Status: accepted, 26 Sep 2026 · Workstream: vault · Spec: sections 7.5 and 11 (floor rule 8)

## The problem

A teammate leaves, and a `.env` file of shared keys leaves with them. Nobody knows what the file
held, so nobody rotates anything, and the keys keep working for as long as that person wants.
The Vault exists to make this impossible, and to replace a password manager for a person and for
their agents.

"Impossible" here comes down to four properties:

1. **No value in a file anyone can carry.** Values are sealed at rest. A copy of `~/.vyre`, a
   backup or a stolen disk yields ciphertext.
2. **Sharing without handing over.** By default a teammate gets a *relayed pass*: their calls go
   through the owner's box, which adds the credential on the way out. The value never reaches
   their machine, so they have nothing to walk off with.
3. **Offboarding is one action.** `vault.offboard {person}` ends every relayed pass at once and
   names every item that was ever handed over in sealed form, since only those need rotating.
4. **No value on any screen, log or event** (floor rule 8). Agents use items by name and never
   see them.

## Threat model

Defended:

- Theft or copying of `~/.vyre`, `vyre.db` or backups: everything under `vault/` is AES-256-GCM
  ciphertext, and the key is somewhere else (the keychain, a file readable only by the vyred user,
  or a passphrase).
- A departing holder of a relayed pass: they never had the value. Revoke works immediately
  because every use is a live request to the owner's box.
- A stolen or leaked pass ticket: a ticket carries no secret. Relay requests must be signed with
  the holder's device key, which never leaves the holder's vault.
- A holder pointing a relayed credential at a server they control, to catch it: each relayed item
  is bound to the hosts it may be sent to, redirects are not followed, and the value is scrubbed
  from responses.
- Claude reading values through its tools: `vault.list`, events, logs, audit rows, errors, the
  MCP listing and the HTTP API carry names only. `vault.put` refuses the `mcp` caller, so Claude
  is never the channel a value travels through.
- Ciphertext swapping (moving item B's sealed file into item A's slot so a module granted A
  receives B): the item id and name are bound into each item's key and AAD.
- A process on the socket posing as a module to call `vault.release`: vyred refuses `module:`
  callers arriving over HTTP. Only the loader can assert a module identity.

Not defended, stated plainly:

- Arbitrary code running as the vyred user. It can read the key the same way vyred does. On a box,
  run vyred as its own user so the key file is not the agent's to read. On a Mac, the Rules deny
  commands that reach for the vault folder or the Vault's keychain item, which is defence in
  depth, not a boundary.
- A module the user granted an item to. A grant is trust. That is why grants are explicit and
  audited, and why an agent (the `mcp` caller) cannot grant or share on its own authority: its
  grants and passes wait as *pending* until a person approves them.
- A process started by `vyre vault run`. It receives values in its environment by design. Its
  stdout and stderr are scrubbed of the values it was given (as `op run` does), which stops
  accidents, not a program that transforms a value before printing it.

## Decisions

### 1. Only `node:crypto`

No dependencies. AES-256-GCM, HKDF-SHA256, scrypt, Ed25519 and X25519 are all in Node 22.5+. A
vault is the worst place to take a dependency whose update could read what it encrypts.

### 2. One master key, kept out of the data folder

A random 32-byte **master key** (MK) per Vyre home. Where it lives is the *keystore*, chosen by
`vault.keystore` in `config.json`:

| Keystore | Default on | Where the MK lives |
|---|---|---|
| `keychain` | macOS | A generic password in the macOS keychain, service `vyre-vault`, account the first 16 hex of sha256(vault folder), so two homes never collide. Written through `security -i` on stdin, never on argv. `vault.keychain` names a specific keychain file (tests use a temporary one). |
| `file` | Linux | `vault/key`, mode 0600, in a 0700 folder, in a home owned by the vyred user. |
| `passphrase` | on request | Nowhere at rest. `vault/key.wrapped` holds the MK wrapped by a key from scrypt (N=2^17, r=8, p=1) of the passphrase. The vault is locked until `vyre vault unlock`. |

The keychain and key file keep the vault usable by agents while nobody is at the machine, which
is the point of a box. The passphrase keystore is for people who want the disk alone to be
useless.

scrypt rather than PBKDF2: it is memory-hard, so a stolen `key.wrapped` costs an attacker memory
as well as time, and Node has it built in. The prototype used PBKDF2 at 600k rounds for a blob a
phone had to open; the Vault key is only ever unwrapped by vyred.

### 3. A key per item, bound to the item

Each item is sealed with its own key: `HKDF-SHA256(MK, salt = item id, info = "vyre vault item v1")`,
a random 12-byte IV, and AAD `vyre:item:v1:<id>:<name>`. The sealed file is
`vault/items/<id>.json`:

```json
{ "v": 1, "alg": "A256GCM", "iv": "<b64>", "tag": "<b64>", "ct": "<b64>" }
```

The plaintext is the item's `fields` object as JSON. Writes go to a temporary file and are
renamed into place, so a crash never leaves half an item.

Per-item keys mean a nonce is never reused across items even if the RNG repeats one, and binding
id and name means a file moved to another item's slot fails authentication instead of decrypting
into the wrong grant.

### 4. What is listable and what is sealed

An item is `{ name, kind, description, fields }`. Kinds: `secret`, `api-key`, `login`, `card`,
`note`, `env-set`.

- **Listable, in `vault_items` in vyre.db:** name, kind, description, the *names* of its fields,
  `url` for a login (autofill has to match pages without unsealing), `hosts` (where a relayed
  pass may send it), created, updated, whether it must be rotated, and where it came from.
- **Sealed, in `vault/items/`:** every field value, including a login's username and a TOTP
  seed.

The sealed files live in the vault folder rather than in vyre.db because the Rules already deny
any tool that reaches into `vault/`, and vyre.db is readable by every module.

### 5. Release: a grant, per module, checked by the vault

`vault.release {name, field?, watcher?}` is registered `internal: true`, so only modules can call
it and it is never listed. It returns `{ value }` only when a grant exists for exactly the calling
module (and, for the watcher runtime, exactly that watcher). Names are matched exactly; the
prototype learned that fuzzy lookup before a grant check lets a fragment reach another agent's
credential.

The manifest's `needs.vault` is checked by the loader in `ctx.vault.fetch`, but a module could
call `vault.release` through `ctx.call` directly, so the **grant is the boundary**, not the
declaration. Every release, refusal and miss is an audit row: when, which item, which module,
the outcome. Never the value.

### 6. Who may call what

Callers are `cli`, `local` (another client on the socket, such as the Deck), `mcp` (Claude) and
`module:<name>`.

| Tool | cli / local | mcp | module |
|---|---|---|---|
| `vault.put`, `vault.unlock`, `vault.approve`, `vault.inject` | yes | refused | refused |
| `vault.grant`, `vault.pass.create` | yes | pending until approved | refused |
| `vault.list`, `vault.audit`, `vault.pass.list`, `vault.revoke`, `vault.pass.revoke`, `vault.offboard`, `vault.import`, `vault.identity`, `vault.pass.accept`, `vault.relay` | yes | yes | yes |
| `vault.totp` | yes | refused | with a grant |
| `vault.generate` | yes | only with `name` (stored, never returned) | refused |
| `vault.release` | no (internal) | no | with a grant |

Taking access away is always allowed; giving it needs a person. A tool a caller may not use is
also left out of that caller's listing, so Claude is not offered `vault.put`.

### 7. Passes

Each Vyre has a device **identity**: an Ed25519 key for signing and an X25519 key for receiving
sealed items, both private halves sealed in the vault. Its public **card** is
`vyre-card:v1:<base64url JSON {name, sign, box, relay}>` and carries no secret.

`vault.pass.create {holder, card?, items, mode?, hosts?, expires?, note?}` returns a **ticket**,
`vyre-pass:v1:<base64url JSON>`, for the owner to send the holder. It carries no secret either:
the pass id, the owner's relay address and signing key, the item names and, for a sealed pass,
each item encrypted to the holder's box key.

- **Relayed (default).** The holder calls `vault.relay {item, request}` with a request whose
  headers or body contain `{{vault}}` (or `{{vault.<field>}}`). Their vyred signs
  `{pass, item, request, ts, nonce}` and posts it to the owner's relay listener. The owner checks
  the signature against the pass's holder key, that the pass is active and unexpired, that the
  item is in it, that the request's origin is in the item's `hosts` (narrowed by the pass's own
  `hosts`), the timestamp is within 60 seconds and the nonce is new. Then it substitutes the
  value, sends the request with redirects off, a 30-second timeout and a 5 MB cap, scrubs the
  value from the response and returns it. A relayed item with no `hosts` cannot be put in a pass:
  a credential that may be sent anywhere may be sent to the holder.
- **Sealed (on request).** Each item's fields are encrypted to the holder with ECIES: an
  ephemeral X25519 key, `HKDF-SHA256(shared, salt = ephemeral public key, info = "vyre pass seal v1")`,
  AES-256-GCM with AAD `vyre:pass:v1:<pass id>:<item>`. The holder's `vault.pass.accept` stores
  them as ordinary sealed items. Revoking a sealed pass cannot un-send it, so it marks each item
  **rotate**, and `vault.list` shows the mark until the item is `put` again.

The relay listener is a separate HTTP server owned by the vault module, bound to
`vault.relay.host`/`port` in config (the tailnet address in production, set up by the box
workstream). It serves one route, `POST /v1/relay`, and nothing else. When the Gate lands (M9),
it takes over adding credentials at the boundary and this listener becomes its client.

### 8. Offboarding

`vault.offboard {person}` revokes every pass that person holds, forgets their card so they cannot
be given new passes by mistake, and returns `{ revoked: [pass ids], rotate: [item names] }`, where
`rotate` is exactly the items they received sealed. It emits `person.offboarded` with the counts.

### 9. `vyre vault run` and `vault.inject`

The CLI asks vyred for the values over the socket (`vault.inject`, cli and local only, never
listed for Claude or modules), puts them in the child's environment only, and pipes the child's
stdout and stderr through a scrubber that replaces each value with `<concealed by vyre>`. Nothing
is printed and nothing is written to disk. Each run is an audit row naming the items and the
command's first word.

### 10. Items for people: TOTP, generate, import, and the autofill API

- `vault.totp {name}`: RFC 6238 (SHA-1/256/512, 6 or 8 digits, period from the `otpauth://` URI
  or 30 s) from the item's sealed `totp` field.
- `vault.generate {length?, words?, symbols?, name?}`: characters from `crypto.randomInt` with no
  modulo bias, or words made of three consonant-vowel syllables (80^3 per word, 18.9 bits), which
  needs no word list and so no licence file. Returns the entropy in bits.
- `vault.import {file, format?}`: `.env`, 1Password CSV, Bitwarden CSV and JSON, Chrome CSV and
  Safari CSV, recognised by their headers. vyred reads the file itself, so values never pass
  through Claude. The file is never modified; the result tells the user to delete it. 1Password
  `.1pux` (a zip) is next.
- Autofill, designed now and built after the core: `vault.match {url}` returns names and hosts of
  logins for a page (no values), and `vault.fill {name}` returns a login's username and password
  only to an unlocked surface session (Touch ID through the Capsule helper, or a passphrase on the
  Deck). Agents never get `vault.fill`.

## Consequences

- A copied `~/.vyre` is worthless without the keychain item, the key file, or the passphrase.
- Losing the keychain item or passphrase loses the vault. `vyre vault export --sealed` (next) will
  write a passphrase-sealed backup.
- Relayed passes need the owner's box to be up and reachable. That is the price of revocation
  that works; sealed passes exist for the offline case, and they are the only thing offboarding
  asks anyone to rotate.
