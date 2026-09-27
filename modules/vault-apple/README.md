# vault-apple: Vyre AutoFill on iOS and macOS

An AutoFill credential provider (`ASCredentialProviderViewController`) for iPhone, iPad and the
Mac (ADR 0028, decision 6). It fills passwords, passkeys (iOS 17, macOS 14) and one-time codes
(iOS 18, macOS 15) from vyred's fill listener (core/vault/fill.js), and puts the vault's sites
and usernames into the system AutoFill list so they show in QuickType and the passkey sheet.

It is the sibling of modules/vault-android/ and keeps its names: AutofillCore, FillClient,
VaultStore. Until there is a paid Apple Developer team it builds for the simulator and for macOS
unsigned, and is never installed.

## What is in it

```
modules/vault-apple/
  project.yml                         XcodeGen: iOS and macOS host + extension, the core tests
  Shared/                             compiled into every app and extension target
    AutofillCore.swift                pure Swift, standard library only: origins, identity
                                      mapping, the challenge check, the server address, base64url, SPKI
    FillClient.swift                  the fill listener's HTTP client
    DeviceKey.swift                   the Secure Enclave P-256 key and its biometric signature
    VaultStore.swift                  Keychain: server, device token; the session in memory only
    VyreSession.swift                 challenge, sign, unlock; run a request inside a fill window
    IdentitySync.swift                identities into ASCredentialIdentityStore
  Extension/
    Sources/CredentialProviderViewController.swift   the provider, UIKit or AppKit by #if
    Sources/PickerView.swift          the one SwiftUI screen: names, never values
    iOS/Info.plist, macOS/Info.plist  NSExtension: credential-provider-ui, capabilities
    iOS/VyreAutofill.entitlements, macOS/...          need a paid team (not applied)
  Host/
    Sources/VyreAutofillHostApp.swift pairing, sync, AutoFill settings, unpair
    Sources/PairingView.swift
    iOS/Info.plist, macOS/Info.plist
    iOS/VyreAutofillHost.entitlements, macOS/...      need a paid team (not applied)
  Tests/AutofillCoreTests.swift       XCTest for AutofillCore, no host app, no device
```

Targets: `VyreAutofillHost-iOS` (application, `sh.vyre.autofill.host`) embedding
`VyreAutofill-iOS` (app extension, `sh.vyre.autofill.host.extension`), the same pair for macOS
(`VyreAutofillHost-macOS`, `VyreAutofill-macOS`), and `VyreAutofillCoreTests` (macOS unit tests).

## Building

In CI (GitHub Actions, macOS runner, Xcode 16 or later, `brew install xcodegen`):

```sh
cd modules/vault-apple
xcodegen generate
xcodebuild -scheme VyreAutofill-iOS -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme VyreAutofill-macOS CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme VyreAutofillCoreTests test
```

The generated `VyreAutofill.xcodeproj` is not checked in. project.yml already sets
`CODE_SIGNING_ALLOWED: NO`; the flag on the command line keeps CI honest if someone turns it on.

## The flows

**Pairing (host app).** The person runs `vyre vault pair --phone` on the Mac (it asks for Touch
ID) and types the code, vyred's address and a device name into the host app. The app makes a
P-256 key in the Secure Enclave with `SecAccessControl [.privateKeyUsage, .biometryCurrentSet]`,
exports its public key as SPKI DER, base64url, and sends `POST /v1/fill/pair { code, name, key }`
with no Origin header. The device token that comes back goes into the Keychain, in the access
group the app and the extension share. A failed pairing deletes the key. Then it syncs.

**Sync (host app, after pairing and on each launch).** `POST identities` needs a live session,
so the app opens one first (below: one Face ID). Every login becomes one
`ASPasswordCredentialIdentity` per https site, stored as a `.URL` identifier holding the exact
origin; every passkey becomes an `ASPasskeyCredentialIdentity`; `recordIdentifier` is always
the item's name. `replaceCredentialIdentities` swaps the whole list. With `users: "names"` the
item's name stands in for every username, passkeys included. Passwords never go in the store.
The store refuses writes until Vyre is turned on in AutoFill settings; the app says so.

**Opening a fill window.** `POST challenge`, then AutofillCore.messageToSign checks the reply is
exactly `vyre:fill-unlock:v1:<challenge>` (the key signs nothing else, whatever a server sends),
then an `LAContext` biometric prompt, then `SecKeyCreateSignature` (ECDSA P-256 SHA-256, DER)
with that context, then `POST unlock { signature }`. The session is kept in memory only, ends at
vyred's `expires` (less 5 seconds), and ends early when the device locks or the Mac sleeps.

**The list (`prepareCredentialList`).** Each `.URL` or `.domain` service identifier becomes
`https://<host>` (a non-default port kept). Other identifier types, http URLs, user info and IPv6
literals give nothing. `POST match { url }` with the device token alone returns names; the list
shows names and descriptions. For a passkey request (`prepareCredentialList(for:requestParameters:)`)
it also lists `POST passkeys { url: https://<rpId>, rpId }`, filtered by the request's allowed
credentials. Tapping a row opens a fill window if needed, then `fill { name, url }` and
`completeRequest(withSelectedCredential:)`, or `passkey.assert` and `completeAssertionRequest`.

**One tap from QuickType (`provideCredentialWithoutUserInteraction(for:)`).** Completes only
when a session is live in this process's memory; otherwise it cancels with
`ASExtensionError.userInteractionRequired`, and the system calls
`prepareInterfaceToProvideCredential(for:)`, which unlocks (Face ID) and fills. An expired session
is proven again once.

**Passkeys.** The OS gives the provider a `clientDataHash`, not the challenge, and builds
clientDataJSON itself. vyred's `passkey.get` builds clientDataJSON from a challenge, so it cannot
serve this. The Swift side calls `POST passkey.assert { rpId, clientDataHash, credential }` and
expects `{ authenticatorData, signature, userHandle }` (see "Needs from the vault team").
Registering a new passkey from the system sheet can use `passkey.register` (the extension still cancels until that path is wired).

**One-time codes (iOS 18, macOS 15).** `prepareOneTimeCodeCredentialList` lists logins for the
page from `match`; a tap runs `POST otp { name, url }` and `completeOneTimeCodeRequest`. A
QuickType code (`ASOneTimeCodeCredentialRequest`) goes the same way. Code identities are written
only for logins the server flags `totp: true`.

**What never happens.** Nothing logs or prints. Errors carry vyred's code and the HTTP status;
vyred's messages are dropped because they can name an item. `LoginValue`, `OneTimeCode` and
`PasskeyAssertion` redact their descriptions and mirrors. No redirect is followed, so the token
cannot be carried to another host. The client sends no cookies and caches nothing.

## The origin rule (ADR 0028, threat model)

- A service identifier of type `.URL` or `.domain` becomes `https://<host>`, lower case, with a
  port other than 443 kept. Exact origin only: the server fills a login only when its hosts
  include that whole origin, and nothing here widens `login.harlow.test` to `harlow.test`.
- An http URL gives no origin. A login saved for https is never offered to a page on plain
  http, and Vyre does not fill plain http on Apple devices. (The Android module allows http when
  the page says so; this one is stricter on purpose.)
- Passkeys follow the server's rpId rules (webauthn.js `rpIdAllowed`); the OS has already bound
  the rpId to the page or app through associated domains.
- The identity store: iOS decides which stored identity to offer in QuickType. Entries are
  written as `.URL` identifiers with the exact origin so the OS has no bare domain to widen,
  and the fill still sends that origin to vyred, which checks it again.

## Where it plugs in later

- **mobile's iOS app** (vyre-mobile `apps/ios/project.yml`, bundle `sh.vyre.app`): add a
  `VyreAutofill` app-extension target there with `Extension/Sources` and `Shared`, bundle
  `sh.vyre.app.autofill`, the Extension/iOS Info.plist and entitlements, and embed it in `Vyre`.
  The host screens (Host/Sources) fold into the app's Vault settings: pairing, sync on launch,
  "Open AutoFill settings". Keychain group becomes `$(AppIdentifierPrefix)sh.vyre.shared` in both
  the app's and the extension's entitlements. mobile builds with Swift 6 and complete strict
  concurrency; this module is written and checked in Swift 5 mode, so expect Sendable fixes
  (FillClient's shared URLSession, VaultStore's observers, the `run` closure).
- **capsule-pro's Capsule** (the native Mac app): add an app-extension target
  `sh.vyre.capsule.autofill` (ADR 0028, decision 6) with `Extension/Sources` and `Shared`, the
  Extension/macOS Info.plist and entitlements, embedded in the Capsule. On the Mac vyred is local,
  so the server is `http://127.0.0.1:<fill port>`, and the Capsule can pair the extension itself
  with a phone code and never show the pairing screen. The device token lives in the Capsule's
  keychain access group.
- This folder's host app is for the simulator and CI until then.

## What needs the Apple Developer team

- The `com.apple.developer.authentication-services.autofill-credential-provider` entitlement
  and the `keychain-access-groups` entitlement, which come with a provisioning profile. Without
  them the extension does not appear in AutoFill settings, the app and extension do not share
  the Keychain (VaultStore then leaves the group out and each has its own), and on a device the
  Secure Enclave key cannot be made in the shared group.
- `$(AppIdentifierPrefix)` only expands with a team. AutofillCore.keychainGroup ignores an
  unexpanded or prefix-less group.
- Signing on macOS: an unsigned app with a credential provider is not loaded by the system, and
  the macOS extension must be sandboxed (its entitlements file already asks for it).
- Face ID on a device, a real Secure Enclave key, and a real AutoFill request: all need an
  installed, signed build.

## From the vault team (done on work/vault-next)

- `POST /v1/fill/passkey.assert { rpId, clientDataHash, credential }` returns
  `{ credentialId, authenticatorData, signature, userHandle }`; device token plus a live session.
- `POST /v1/fill/passkey.register { rpId, clientDataHash, user, algs, exclude? }` returns
  `{ name, credentialId, attestationObject, authenticatorData, publicKey }` (none attestation, so
  the hash is not signed). The extension's "cancel and let another provider make it" can become a
  real registration.
- `identities` now carries `userHandle` on passkeys, honours `"names"` for passkeys too, and
  flags logins with a seed `totp: true` (never the seed).
- Still open: the extension keeps its session in memory, so most fills ask for Face ID, stricter
  than the 30-minute window. Keeping the window means the session token in the shared Keychain
  group; the vault team's call, not made yet.

## Not done yet, not verified

- Nothing here has been built with xcodebuild, run in a simulator or installed. Every Swift file
  was type-checked with `swiftc -typecheck` against the iPhoneSimulator and MacOSX SDKs (Xcode
  26.5 SDKs, Swift 5 mode, iOS 17 and macOS 14 targets). The XcodeGen spec generates.
- The tests have been type-checked, not run.
- The session is memory only, as asked. An extension process lives for one request, so in
  practice every fill after the first asks for Face ID, which is stricter than decision 5's
  30-minute window. Keeping the window across requests would mean storing the session token in
  the Keychain (`ThisDeviceOnly`, with its expiry) and is a decision for the vault team.
- Face ID and Touch ID only. A device with neither cannot unlock (DeviceKey checks
  `canEvaluatePolicy` before the prompt), as on Android.
- The simulator has no Secure Enclave; DeviceKey makes a software key there so the flow can run
  in CI. A device build never takes that path.
- Saving a login typed into a page: the system gives credential providers no save hook for
  passwords, so `save` is not wired.
- Cards and addresses: not part of AutoFill credential providers on iOS or macOS.
