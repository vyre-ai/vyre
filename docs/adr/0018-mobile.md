# ADR 0018 · The phone apps: native iOS and Android on the box's API

Status: proposed, 27 Sep 2026 · Workstream: mobile (`apps/ios`, `apps/android`) · Spec: sections
2, 7.1, 9, 10, 11 · Builds on ADR 0002 (network and identity), ADR 0004 (presence), ADR 0011
(web push)

## The problem

The Deck on a phone is a web page. It works, but it is not how a phone app feels: no share sheet,
no lock-screen actions, no voice, and Web Push on iOS only after "Add to Home Screen". The user
wants the Deck, Chat and the Capsule on iPhone and Android as real apps, with the same reach as
every other surface: every session, the assistant, agents, held approvals, memory, the vault
behind presence, and files.

Four questions decide the design: what the app talks to, how it proves a person is there, how it
is told something needs them while closed, and what it keeps on the phone.

## Decision

### 1 · Two native apps, one contract

- **iOS**: Swift and SwiftUI, iOS 17 and later, no third-party packages. **Android**: Kotlin and
  Jetpack Compose, API 29 and later, AndroidX and OkHttp only. No cross-platform framework.
- Both are thin clients of vyred's public API, like the Deck (spec section 9): `POST /v1/tools/<name>`,
  `GET /v1/events/stream`, `POST /v1/presence/challenge`. Neither has logic the Deck lacks; a
  screen that needs something new asks for a tool, it does not compute it on the phone.
- The shared client contract is `apps/CONTRACT.md`, taken from the code (not the docs) and kept
  current by this workstream. Each app has one API client that is the only thing that opens a
  connection, the same rule as `deck/js/api.js`.

### 2 · What the app talks to

- **The box, over the tailnet.** The app stores one address, the box's HTTPS name (`vyre.<tailnet>.ts.net`
  or the user's own domain), and talks to it as any of the owner's devices: the phone is on the
  tailnet as the owner's login, so vyred sees `tailnet:<login>` from `tailscale whois` (ADR 0002).
  There is no account, password or cookie. The certificate is an ordinary public one (Let's
  Encrypt or `tailscale cert`), so the platform's own trust store checks it; no pinning, since a
  renewal must not break the app.
- The app sends `content-type: application/json` on every POST and **no `Origin`**, so it passes
  ADR 0002's browser checks as a non-browser client. It never sends `x-vyre-caller`: over the
  tailnet vyred ignores it.
- **Every write names its surface**: `surface: "ios"` or `"android"` on `threads.start`, `send`,
  `lease`, `release`, `answer` and `agents.ask`, always the same value, so the keyboard lease
  (floor rule 4) sees one holder.
- **Setup** is a QR code or a typed address. The Deck's onboarding step 6 already shows the
  address as a QR; the app reads `https://<address>` from it. If Tailscale is not connected the app
  says so and opens the Tailscale app; it does not embed Tailscale.
- **The Mac.** A Mac's vyred has no network listener (ADR 0002, "The Mac"), and nothing lets the
  box reach it, so the phone cannot reach the Mac today. The apps show Mac files and sessions only
  through the box, once the link or tailnet workstream gives the box a way to ask the Mac (a
  box-to-Mac `link.remote` over the connection the Mac already keeps open). Until then "Mac" is a
  row that says "Reachable through the box once linking lands". No listener is added to the Mac
  for the phone's sake.
- **Other tailnet devices** appear only through tools the tailnet workstream exposes (Taildrop,
  device list). The app asks the box; it never talks to Tailscale's API itself.

### 3 · Presence on the phone: a device key, enrolled with the Deck's passkey

ADR 0004 says a tailnet caller is a device, not a person, and every human-only tool needs a
proof. On a phone the natural proof is Face ID or a fingerprint, and the platforms give exactly
that to a key held in hardware.

- **A device key.** On first sign-in the app makes an ECDSA P-256 key that never leaves the
  phone: in the Secure Enclave on iOS (`SecAccessControl` with `.biometryCurrentSet` and
  `.privateKeyUsage`), in StrongBox or the TEE on Android (`setUserAuthenticationRequired(true)`,
  a per-use biometric prompt, invalidated when a new fingerprint is enrolled). Every use shows
  the system biometric sheet, with the tool's summary as its reason.
- **A new presence method, `device`**, beside `capsule` in `core/presence`: the key is enrolled
  as `presence.enroll {kind: "device", public_key (SPKI DER, base64url), alg: -7, name}`, and a call
  carries `x-vyre-presence: device key=<id> ts=<ms> nonce=<n> sig=<DER ECDSA, base64url>`. The
  signed message is the Capsule's: `vyre-presence-v1\n<tool>\n<input hash>\n<ts>\n<nonce>`, with the
  same 60-second window and single-use nonce. `capsule` stays Ed25519, because the Secure Enclave
  cannot hold Ed25519 and Android Keystore holds it only from API 33 and never in StrongBox.
- **Sign-in is the Deck's passkey.** Enrolling the device key is `presence.enroll`, which is on
  the floor's list, so a new phone is approved like any device: by a proof from something already
  trusted. The app opens `https://<address>/onboard/device#k=<public key>&n=<name>` in the
  system's authentication browser (`ASWebAuthenticationSession`, Android Custom Tabs). That page
  is served by vyred at the box's own origin, so `navigator.credentials.get` runs against the same
  relying party (the box's host) and the same passkeys the Deck enrolled, synced by iCloud
  Keychain or Google Password Manager. The page asks for the passkey, calls `presence.enroll` for
  the device key with that proof, and returns to `vyre://enrolled?id=<key id>`. If the box has no
  passkey yet, the page takes a one-time code from `vyre presence code` instead, exactly as the
  Deck's first-passkey page does.
- **Why not the platform passkey API in the app.** `ASAuthorizationPlatformPublicKeyCredentialProvider`
  and Android's Credential Manager only assert for a relying party the app is associated with,
  through `apple-app-site-association` and `assetlinks.json`. Apple and Google fetch those files
  from the public internet, and the box's name resolves to a tailnet address they cannot reach. A
  store build cannot name a per-user host in its entitlements either. The authentication browser
  runs the same WebAuthn ceremony against the box's own origin with none of that. A developer
  build with `webcredentials:<host>?mode=developer` can use the in-app API, and may later.
- **What the phone proves with.** Approve, discard, answer, reveal, copy, TOTP, take over, lesson
  accept and pairing all sign with the device key. For revealing several vault items in a row the
  app opens `presence.session.open` once (device proof) and uses its `session` header for
  `vault.reveal` and `vault.totp` until it ends (5 minutes idle, 30 at most, bound to this node).
- **Losing a phone** is `presence.remove <id>` from any other device, which the Deck's Settings
  already lists. A reinstall makes a new key and signs in again.

### 4 · Push: native, content-free, through `core/push`

- **Same payload as Web Push.** `{kind, title, path, tag, at}`: the kind, a fixed sentence and a
  path holding only an id (ADR 0011 point 2). The app fetches the details after the tap over its
  own connection to the box.
- **The path is encrypted to the device.** At registration the app sends a random 32-byte key;
  the box seals `{path, tag, at}` with AES-256-GCM under it. iOS sends an alert with the fixed
  title and `mutable-content`, and a Notification Service Extension opens the sealed part into the
  notification's `userInfo`. Android sends a data-only FCM message and the app posts the
  notification itself. Apple and Google see a kind and a fixed sentence, never an id.
- **Transports.** `push.subscribe` gains `{transport: "apns"|"fcm", token, key, bundle, env}`
  beside the Web Push subscription; `deliver()` branches to an APNs HTTP/2 or FCM v1 sender that
  answers `{ok, status, gone}` like the Web Push one. Hosts: `api.push.apple.com`,
  `api.sandbox.push.apple.com`, `fcm.googleapis.com`, already covered by ADR 0011's allowlist.
- **The credential problem.** APNs and FCM accept a push only with the app publisher's key: an
  APNs `.p8` key of the Apple team that signed the app, and a service account of the Firebase
  project the Android app is built with. A self-hosted box does not have the publisher's key.
  - **Now: bring your own.** Whoever builds and signs the app (the owner, while it is not in the
    stores) puts the key in the Vault as `push-apns` or `push-fcm`, granted to module `push` only,
    and the box sends directly. This works for a personal build, TestFlight and an internal
    Android build.
  - **For store builds: a decision.** Either Vyre AI runs a push relay at `push.vyre.run` (a second
    hosted service, which the spec's "Vyre AI runs one thing" forbids today), or Android uses
    UnifiedPush through a distributor the owner picks and iOS needs the relay regardless. The relay
    would hold the publisher keys, receive only sealed, content-free payloads signed by the box's
    directory key, and keep nothing. Not built until the spec says so.
- **Quiet hours and per-kind switches** are `push.settings`, shared with the Deck.
- **Notification actions** (Approve, Deny on the lock screen) wait until later: an action must
  show the final words before it approves (floor rule 1), and the lock screen does not. A tap
  opens the item.

### 5 · Live updates, and staying light

- **One event stream while the app is in front**, `GET /v1/events/stream?since=<last>`, resumed
  with `Last-Event-ID`, parsed by a small SSE reader of our own. It closes within a second of the
  app leaving the screen; nothing polls in the background (principle 8). Push covers the closed
  app.
- On return the app reads `/v1/health`'s `last_event` and resumes from its own last id, so a gap
  is replayed, not lost. Streamed text deltas are pruned from the log 60 s after a turn ends, so
  a thread that finished while away is re-read with `threads.get`.
- The lease is renewed every 60 s only while the composer is focused and the app is in front.

### 6 · What stays on the phone

- **Cached for offline reading**, the Deck's rule (deck.md, "the service worker now caches two
  reads"): `projects.list`, `agents.list`, and `threads.get` for threads the person opened,
  capped at 20 threads and 7 days. Stored in the app's own container with iOS
  `NSFileProtectionComplete` and Android app-private storage, excluded from backups.
- **Never cached**: held items' content, vault anything, memory facts, files, tool results other
  than those three. A held item's words stay on the box.
- **Keychain / Keystore**: the device key (hardware, not exportable), the box address, the push
  key. Nothing else.
- **Signing out** removes the device key from the box (`presence.remove`), deletes the local key,
  the cache and the push registration.

### 7 · Vault on the phone

`vault.list` shows names, kinds and hosts. A value appears only after a device proof for that one
item (floor rule 8), inside a sheet that conceals it after `concealAfter` seconds and when the app
leaves the screen, with the screen marked secure (Android `FLAG_SECURE`, iOS a blur on
`scenePhase` change). Copy puts it on the phone's own pasteboard as local-only and expiring
(`UIPasteboard` `localOnly` + `expirationDate`, Android `EXTRA_IS_SENSITIVE`), never on the box's
clipboard (`vault.copy` copies there, so the app uses `vault.reveal` and copies itself). Autofill
providers for other apps are the vault workstream's, later.

### 8 · Voice

On-device speech recognition only (`SFSpeechRecognizer` with `requiresOnDeviceRecognition`,
Android `SpeechRecognizer` with `EXTRA_PREFER_OFFLINE`). The words go into the Capsule's search
box to be read before sending. No audio leaves the phone.

## Consequences

- `core/presence` gains a key kind and a method (security owns it; a small change listed in
  mobile.md under "Changed contracts"). `core/push` gains native transports (switchboard owns it).
  `deck/onboard/device/` is a new page in the Deck (deck owns the folder).
- The tools the phone needs most refuse tailnet callers today: `callers` lists compare the whole
  `tailnet:<login>` string, so `gate.get/approve/reject/revise`, `threads.answer`, `push.*` and
  the vault's surface tools answer `denied` to any device, the Deck on the tailnet included. A
  `tailnet` entry in a `callers` list must match any `tailnet:*` caller, and those tools must list
  it. Presence still decides the human-only ones.
- Store releases wait on the push-relay decision, on App Review accepting an app that needs a
  self-hosted server (a demo box for review), and on the user's own developer accounts. The steps
  are in `apps/RELEASE.md`; none is done by an agent.
- Two more clients to keep in step with the contract. `apps/CONTRACT.md` and a contract test
  against a real vyred in a temp home keep them honest.

## Addendum, 27 Sep 2026 · The push relay (proposed, for decision)

Store builds are signed by Vyre AI, so only Vyre AI's APNs key and Firebase project can push to
them. Today a box sends pushes itself with the owner's own keys (section 4), which works only for
an owner who builds the app. Three ways out; the choice changes SPEC section "Not a hosted
service", so it is the lead's and the user's.

1. **A relay beside the name directory (recommended).** `push.vyre.run` holds Vyre AI's APNs key
   and FCM service account and nothing else. It is the same service as `api.vyre.run`, not a
   second one: the directory already knows each box by its Ed25519 directory key.
   - The phone registers with its box as today (`push.subscribe {transport, token, key}`). The box
     then registers the token with the relay once: `POST /v1/devices {token, transport, bundle,
     env}` signed with its directory key. The relay stores `(box key, token hash) -> token` and
     answers a random `device` id; the box keeps only that id.
   - To push, the box sends `POST /v1/push {device, kind, title, sealed, tag}` signed with its
     directory key. `sealed` is the AES-256-GCM blob of `{path, tag, at}` under the phone's own
     key (section 4), so the relay sees a kind, a fixed sentence and ciphertext. `title` must be
     one of the fixed sentences per kind; the relay refuses anything else, so a box cannot put
     content in it.
   - The relay keeps no payloads and no logs of them, rate-limits per box key (60 a minute, 1,000
     a day), and deletes a token when APNs or FCM says it is gone. A box that stops paying or is
     banned loses the relay only; everything else it does is unchanged.
   - Self-built apps keep sending directly with the owner's keys. The app says which in
     `push.subscribe` (`via: "relay"|"direct"`), from how it was signed.
2. **UnifiedPush on Android, relay on iOS only.** The owner installs a distributor (ntfy, or one
   on their box) and no Google key is involved. iOS still has no way round APNs, so this halves
   option 1 and adds a setup step for Android owners.
3. **No relay.** Store builds have no push; the app refreshes when opened, and the PWA's Web Push
   (ADR 0011, which needs no publisher key) covers alerts. Honest, and the cheapest, but a native
   app without notifications is weaker than the PWA it follows.

Recommendation: option 1, as part of the directory, built only when store builds are scheduled.
Until then option 3 is what store builds would do, and self-built apps push directly.
