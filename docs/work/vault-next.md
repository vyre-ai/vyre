# vault-next

Branch: work/vault-next · Worktree: ../vyre-vault-next · ADR: 0028 (docs/adr/0028-vault-everywhere.md)

## Scope

Import on day one (preview, duplicates by content, Apple Passwords), agent logins (one agent,
one login, one origin, a log of every use), rotation reminders through the planner, and autofill
on every device through the OS's own autofill UI (iOS, Android, Mac, browsers, agent computers).
Owns core/vault/ changes for these, modules/vault-extension/, and the autofill extension code on
mobile and the Capsule (through their owners).

## Done

- ADR 0028 written (proposed), in nav.json. Number claimed in docs/work/README.md.
- Import preview with a file-bound token, duplicates by origin+username, Apple Passwords (782ab9d).
- Agent grants + vault.uses log, the 30-min fill window, Firefox extension build (WIP commit at
  resume after logout 3; tests green).
- Step 1, .env import: core/vault/detect.js (types + ~40 providers, fixed words only),
  core/vault/envfiles.js (spans, item names, folder scan, rewrite, git state). A .env file is one
  env-set; only secrets move; folder scan; `rewrite` to vault:// refs; CLI `--rewrite` + per-file
  preview. Tests: detect.test.js, env-import.test.js. vault + CLI suites on testbox: 264 pass, 0 fail.

- Step 2: `vyre run -- cmd` (core/cli/commands/run.js): reads ./.env refs when nothing is named.
  No vault.env.resolve needed: sessions already reads claude-setup-token / anthropic-api-key through
  a module grant (ctx.vault.fetch). Told sessions; asked whether owned sessions' Bash should resolve
  project refs (my default: no).

- Step 3 typed credentials (core/vault/kinds.js, details column, Watchtower expired/expiring,
  passkey never released, CLI put flags).
- Step 4 import sources (core/vault/import-more.js): LastPass, Dashlane (zip/CSV), Keeper (CSV/JSON),
  NordPass, Proton Pass (zip/JSON/CSV), Enpass, KeePass/KeePassXC (XML/CSV; kdbx refused with how
  to export), Firefox, Edge/Brave/Arc/Opera/Vivaldi (chrome-csv). Safe XML reader (no DOCTYPE).
  Unsure layouts (from memory, fixtures only): Keeper headerless CSV, Dashlane payments/ids,
  Proton state/expiry, Enpass cc field types. vault + tools + CLI + extension: 415 pass, 0 fail.

- Steps 5+6, the authenticator: core/vault/otpmigration.js (protobuf, multi-part batches),
  core/vault/codes.js, vault.codes (current + next + remaining) and vault.codes.import (people's
  surfaces only, never mcp), vault.totp adds next, CLI `vyre vault codes [import]`. codes.test.js.

- Step 7: vault.sweep (files, git history, shell history; places and names only), vault.rotate
  (auto: AWS SigV4, GitLab self/rotate, Cloudflare roll, GCP SA keys; guided: the rest incl.
  Twilio), vault.rotation, daily reminders -> planner todos (remind.js; box, or an unpaired Mac),
  vault.remind.run. UNVERIFIED against real provider APIs (fake servers only): AWS propagation
  delay on revoke, Cloudflare account-owned tokens, GCP org policies.
- Step 8: `vyre vault ssh import` (~/.ssh keys), `vyre vault ssh setup [--git]` (prints ssh/shell
  lines, applies git signing only with --git, allowed_signers).
- Full vault + tools + CLI + extension + docs set on testbox: 507 pass, 0 fail, 14 skipped.

- Step 10 passkeys: core/vault/webauthn.js (ES256, none attestation, synced flags), fill routes
  passkeys / passkey.create / passkey.get (fill-passkey.js), extension passkey-page.js (MAIN
  world) + passkey-bridge.js (confirm on trusted click, fallback to the browser), popup toggle.
  NOT tried in a real browser yet (needs the Mac free + the lead's OK). Gaps: conditional
  mediation, prf/largeBlob, Android/iOS providers.
- Full set on testbox: 531 pass, 0 fail, 14 skipped.

- Step 11 cards + addresses: fill routes cards / card.fill (reprompt = session under 60 s, no PIN)
  / address.fill; extension cards.js detection (autocomplete + English heuristics, split expiry,
  country selects), inline chooser, popup section. Gap: payment-provider iframes.
- Full set on testbox: 539 pass, 0 fail, 14 skipped.

- Step 12 emergency access (core/vault/emergency.js): an escrowed sealed-pass ticket (AES-GCM, key
  in the agent vault), contact requests over the relay (/v1/emergency), released after the wait
  unless denied; refresh on unlock (daily at most); CLI `vyre vault emergency ...`. Changed
  contracts: relay.serve onEmergency, Vault.ticketFor (issue uses it), offboard ends emergency,
  unlockAccount refreshes. Full set: 548 pass, 0 fail, 14 skipped.

- Every vault tool has a CLI verb (health, remind, history, revert, agent, uses, rotate --how);
  core/cli/commands/vault-next.test.js drives the real bin/vyre.
- Step 13 Android: modules/vault-android/ (Expo local module, Kotlin AutofillService + auth activity,
  StrongBox device key); server: device-key unlock (challenge/unlock {signature}, MACed
  vault_device_keys), `vyre vault pair --phone` codes (only they take a key / may omit Origin),
  android://<pkg>@<sha256> matching for match/fill/otp. Sent to mobile to include. UNVERIFIED on
  gradle/device.

- iOS/macOS: modules/vault-apple/ (credential provider: passwords, passkeys, one-time codes;
  Secure Enclave device key; SwiftUI host; XcodeGen project, unsigned simulator build). Type-checked
  on iOS-simulator and macOS SDKs only. Server: identities (usernames or names, totp flag, passkey
  userHandle), passkey.assert / passkey.register over a clientDataHash.
- hygiene: test fixtures assemble PEM headers at run time. Full set + hygiene: 576 pass, 0 fail.

- ADR 0028 decision 9a, connecting a key: core/vault/providers.js (catalog), needs.credentials in
  the module validator and ctx.vault.fetch, vault.need + vault.connect (tools/needs.js), `vyre vault
  needs|connect`, `vyre voice key` through vault.connect, voice declares its speech group. Hook for
  9b: vault.connect returns {item, module, need, provider, granted, grant} and emits
  vault.connected {module, need, item, provider}. Targeted set on testbox: 584 pass, 0 fail.

- Merge main 7880dfa6 (8272853d): fill.js keeps both keys, browser proof keys (JWK, e2e) and phone
  unlock keys (SPKI string). 394 pass on the vault + docs set.
- ADR 0028 decision 9, Connections (a92f30df). 9a built (37132a25): core/vault/providers.js, needs.credentials in
  manifests (kernel validate + fetch courtesy), ctx.modules.list(), vault.need, vault.connect, `vyre vault needs|connect`,
  `vyre voice key` now calls vault.connect, voice declares a "speech" group. 584 pass, 0 fail.
- core/mail was built (6a0c0760) then reverted (7cb60736): connectors owns core/mail (lead). Offered to them to cherry-pick.

- 9b connections (4d43906e and after): core/vault/connections.js + tools/connections.js, vault_connections (MACed,
  tampered row granted to nothing), vault rows resynced on vault.connected/put/delete, modules register theirs,
  list/get/grant/revoke/update/sync/allowed/register/unregister, events vault.connection-added/-removed/-changed,
  core/modules/needs-credential.js, multiple: true needs, Apps Script mail capabilities + /a/macros URL,
  `vyre vault connections`. Targeted run on testbox: 39 pass, 0 fail.

## Doing

- Nothing. 9b done; waiting on connectors to register google, mcp and mail rows and call allowed.

## Next (in order, when resumed)

0. (0.1.0, lead) Claude sign-in as a need: how "code" in the catalog (sign-in url, then an inline code),
   backed by onboard.claude; group "claude" = setup token or API key. Proposal sent to sessions 27 Sep;
   waiting on: which module declares it, module:vault calling onboard.claude, signin.start() twice.

1. Rotation: revoke-old asks for proof with the new key's name shown (lead decision, ADR 0028 4c);
   then prove each auto provider against a real account.
2. Agent grants per project (ADR 0031): project column, check on every use, revoke by project.
3. Extension request signing (e2e 628e2cd9 x-vyre-proof, key at pairing), then make the key required.
4. vault.reveal {purpose: "copy"} audited as a local copy on the device (mobile asked).
5. The real-browser extension check on TESTBOX: headless Chrome, temp --user-data-dir, local
   fixture pages only, after the integrator's run and under load 8.
6. vault.agent.fill against glass-live's final computers.fill contract (agreed; wiring after native
   core). Pass the grant's ORIGIN (scheme://host[:port]) to computers.fill.begin, never a URL:
   glass-live does not trim it yet.
7. Android: the device check (mobile). The Credential Manager provider is built (type-checked, pure
   core 27 JUnit): check on a device whether Chrome keeps its own clientDataJSON when passing the
   hash; the real system sheet and the unlock action round trip; assetlinks against a real site;
   saving a password from a native app (save, card.fill, address.fill are still web-only on the
   server); excluded credential returns Unknown, not InvalidState. Tell mobile the sha on any module change: their copy is not linked.
8. Apple: parked until after native core; then mobile (iOS app) and capsule-pro (Capsule) add the
   targets from modules/vault-apple. The extension keeps its session in the shared Keychain, 30
   min, cleared on lock (approved).

## Needs from others

- capsule-pro: replace "Run: vyre voice key" (SightExtension.swift:400-402) with an inline secure field that calls
  vault.connect {module:"voice", need}; an account chooser from vault.connections.list {capability}.
- native-core: the "Vault, Connections" entry in the settings hub (list, grant per surface, connect sheet).
- sessions: 9b reads threads.get `thread.origin` (sessions db4af9c3, not on main yet); falls back to purpose, then chat.
- lead: `tailnet:<login>` (the owner's own device on the box) counts as the person, like the Deck; the phone
  arrives that way too, so "phone" is only the `mobile` caller today. Is that right?
- connectors: google.connect wants a `client` item; what should vault.connect's oauth `next.input` carry?

- mobile: include modules/vault-android (sent 27 Sep), run its gradle unit tests + a device check;
  an app group / keychain access group for an iOS VyreAutofill extension target.
- computers (glass-live?): computers.fill.begin/end (internal), Chrome under its own uid, ptrace
  blocked, closing agent CDP websockets on begin.
- capsule-pro: a credential provider extension target in the Capsule app (after Apple team).
- planner: planner.add from module:vault (already allowed), planner.done on items it added.
- polish-cli: CLI keeps a fresh proof per call; fills never ride a CLI window.
- pwa: Deck import sheet (preview, incl. a folder's .env `files`), Grants place and "Used by" rows,
  the Codes list (vault.codes) with a ring from `remaining`, a camera scan via BarcodeDetector ->
  vault.codes.import {uris}.
- mobile: the phone's Codes screen + camera scan -> vault.codes.import (same shapes).
- user: a paid Apple Developer team (NOT approved for now: iOS/macOS providers stay simulator + CI).
- lead: refs stay vault://item/field; accept vyre://vault/... as an alias? Who builds the Deck/phone vault board (Direction A): pwa + mobile, or vault-next?

## Changed contracts

- Kernel (core/modules/index.js): validate() takes needs.credentials[].multiple (boolean, no `item` with it);
  ctx.vault.fetch accepts `<module>-<label>` items of a module with a multiple need. New kernel helper
  core/modules/needs-credential.js (pure). vault.need returns `multiple` and `items` for such needs; vault.connect
  takes `label` as the item suffix there. providers.js: google-apps-script capabilities send_mail, read_mail.

- Kernel (core/modules/index.js): validate() checks needs.credentials; ctx.vault.fetch also accepts
  its items; status() (and GET /v1/modules) carries `credentials`; ctx.modules.list() returns
  status(). voice: module.json needs.credentials, voice.status adds `need` while no key is ready.

- vault.import on a .env file now makes ONE env-set (named after the file's path), holding only
  secrets, instead of one secret per variable. vault.import/preview take a folder and `rewrite`.
