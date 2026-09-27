# vault-android: Vyre autofill on Android

An Expo local module that makes Vyre an Android autofill service and, on Android 14 and later, a
Credential Manager provider (ADR 0028, decision 6). It fills logins, one-time codes, cards and
addresses into apps and browsers from vyred's fill listener (core/vault/fill.js), offers to save
a login someone types, and signs in and registers with passwords and passkeys through the
system's Credential Manager sheet.

Android only. The web and iOS builds never import it.

## What is in it

```
modules/vault-android/
  expo-module.config.json        android: sh.vyre.autofill.VyreAutofillModule
  index.ts                       the app's JS API
  android/build.gradle           namespace sh.vyre.autofill
  android/src/main/AndroidManifest.xml
  android/src/main/res/xml/vyre_autofill.xml          service metadata, compatibility packages
  android/src/main/res/xml/vyre_credential_provider.xml  capabilities: passwords, passkeys
  android/src/main/res/raw/vyre_privileged_browsers.json Google's privileged-browser allowlist
  android/src/main/res/layout/vyre_autofill_item.xml  one suggestion: a name, never a value
  android/src/main/res/values/vyre_autofill.xml       label, translucent theme
  android/src/main/java/sh/vyre/autofill/
    AutofillCore.kt          pure Kotlin: classification, origins, challenge, server URL
    StructureReader.kt       AssistStructure to fields and one origin
    FillClient.kt            the fill listener's HTTP client
    VaultStore.kt            encrypted prefs, the in-memory session, the device key
    Datasets.kt              locked suggestions, inline chips, the filled Dataset
    VyreAutofillService.kt   onFillRequest, onSaveRequest
    UnlockingActivity.kt     the device-key unlock both activities share
    VyreAuthActivity.kt      autofill: unlock, fetch, hand back the Dataset
    CredentialCore.kt        pure Kotlin: caller origins, rpId and asset-link checks, WebAuthn JSON
    CredentialAccess.kt      the caller, the allowlist, assetlinks.json, the sheet's entries
    VyreCredentialService.kt Credential Manager: begin get, begin create
    VyreCredentialActivity.kt  unlock and list, password, passkey assert, create
    VyreAutofillModule.kt    the Expo module
  android/src/test/java/sh/vyre/autofill/AutofillCoreTest.kt     plain JVM JUnit
  android/src/test/java/sh/vyre/autofill/CredentialCoreTest.kt   plain JVM JUnit
```

## The JS API

```ts
import * as Autofill from "../../modules/vault-android";

await Autofill.setServer("https://vault.harlow.test");       // https only; http://127.0.0.1 in a debug build
await Autofill.pair("https://vault.harlow.test", "ABCD2345", "alex's Pixel 8");
await Autofill.status();   // { paired, server, device, name, level, unlocked, enabled, reachable, revoked }
Autofill.isEnabled();      // Vyre is the phone's autofill service
Autofill.openSettings();   // Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE for this package
await Autofill.lock();     // end this phone's fill window now
await Autofill.unpair();   // forget the token, delete the device key
```

Errors reject with `error.code`: `ERR_BAD_SERVER`, `ERR_NO_BIOMETRICS`, `ERR_KEYGEN`,
`ERR_NETWORK`, `ERR_PAIR` (the message starts with vyred's own code), `ERR_NO_CONTEXT`.

## The flows

**Pairing.** `pair(url, code, name)` makes a P-256 device key in the Android Keystore:
StrongBox when the phone has one (falling back to the TEE, as modules/vyre-signer does),
`setUserAuthenticationRequired(true)`, BIOMETRIC_STRONG for every use (0 seconds), invalidated
when the enrolled biometrics change. It sends `POST /v1/fill/pair { code, name, key }` with the
key's SPKI DER as base64url, and keeps the returned device token in EncryptedSharedPreferences
(AES-256-GCM under a Keystore master key). A failed pairing deletes the key.

**A fill request.** The service reads the AssistStructure. For each view that takes a value it
decides a role: autofillHints first, then the HTML attributes (autocomplete, type, then name and
id), then the input type flags, then English words in the resource id, the hint and the HTML
labels. It works out the form's one origin (below), then calls `POST match { url }` (device
token only, no session; names come back, no values). Cards and addresses come from
`POST cards { url }`. Each item becomes a Dataset with no value in it, locked by
`setAuthentication(IntentSender)` to VyreAuthActivity with the item's name. The whole request
is answered within 2.8 seconds (a watchdog answers empty past that), and any failure answers
with no suggestions.

**The tap.** VyreAuthActivity reads the origin again from the AssistStructure the framework
attaches. It does not trust anything the service put in the Intent beyond the item's name and
kind. With no live fill window it calls `POST challenge`, checks that the message is exactly
`vyre:fill-unlock:v1:<challenge>` (the key signs nothing else), runs BiometricPrompt with a
CryptoObject around the device key's Signature, signs (SHA256withECDSA, DER, base64url) and
calls `POST unlock { signature }`. The session is kept in memory only, shared by the service
and the activity in the app's process. Then it calls `fill { name, url }`, `otp`, `card.fill` or
`address.fill` and returns the filled Dataset through `EXTRA_AUTHENTICATION_RESULT`. A card
always asks for a fresh proof, because vyred fills a card only within 60 seconds of one. An
expired session gets one retry after a new proof.

**Saving.** A web form with a password field carries a SaveInfo. On save, with a live session,
the service calls `POST save { url, username, password }`. Without one (Android 9 and later) it
holds the login in memory under a random id for two minutes, and the auth activity unlocks and
then saves. Only the id travels in the Intent.

**Credential Manager, sign in (Android 14 and later).** onBeginGetCredentialRequest needs
vyred's `identities`, and `identities` needs a live fill window. Without one, the sheet shows a
single "Unlock Vyre" action; VyreCredentialActivity unlocks with the device key, calls
`identities` and hands the entries back (setBeginGetCredentialResponse). With one, the service
lists them directly within 1.5 seconds. A login is an entry when the caller's exact web origin is
one of its sites or the caller is listed in its apps as `android:<package>@<sha256>`. A passkey is
an entry when its rp is the request's rpId (and in allowCredentials, when the request lists any).
Picking an entry:

- a password calls `fill { name, url }` and returns a PasswordCredential;
- a passkey works out the caller's origin, checks the rpId (below), builds clientDataJSON
  (`webauthn.get`, the request's challenge, the origin, and `androidPackageName` for an app),
  calls `passkey.assert { rpId, clientDataHash, credential }` with the platform's clientDataHash
  when it gave one and the SHA-256 of our clientDataJSON otherwise, and returns a
  PublicKeyCredential in the WebAuthn toJSON() shape.

**Credential Manager, create.** One "Vyre" entry. A password goes to `save { url, username,
password }` (vyred's save takes web origins only, so an app gets vyred's refusal). A passkey is
checked the same way, then `passkey.register { rpId, clientDataHash, user, algs, exclude }`, and
the registration comes back in the toJSON() shape with `credProps.rk`.

**What never happens.** Nothing logs. No value goes into an Intent extra except the final
Dataset handed to the framework. Suggestions show names only.

## The origin rule (ADR 0028, threat model and decision 6)

- A form with a web domain is a web form. Its origin is `https://<webDomain>` (or `http://`
  when the page's scheme says so, Android 9 and later). Only fields under that same domain are
  kept, so a form in another site's frame is left alone. In compatibility mode the framework
  puts the domain on the browser's URL bar; one domain in the window is taken, more than one
  gets no origin.
- A form with no web domain belongs to the calling app. Its origin is
  `android://<package>@<sha256 of its signing certificate>`, from
  `PackageManager.getPackageInfo(GET_SIGNING_CERTIFICATES)`. An app with more than one signer
  gets no origin. A browser never falls back to its package.
- vyred matches exact origins only. There is no suffix or wildcard match.
- In Credential Manager, a browser is taken at its word about the page's origin only when it is on
  Google's allowlist (`CallingAppInfo.getOrigin` with res/raw/vyre_privileged_browsers.json, from
  https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json). Anything else is the app it
  is, with the WebAuthn origin `android:apk-key-hash:<base64url sha256 of its certificate>`.
- A passkey's rpId must be the web origin's host or a parent of it. For an app, the rpId's
  `https://<rpId>/.well-known/assetlinks.json` must name the app's package and certificate with
  `delegate_permission/common.get_login_creds` or `common.handle_all_urls`; a site that cannot
  be read (3 seconds, no redirects) gives no passkey.

## How mobile includes it

1. Copy or symlink this folder to `apps/app/modules/vault-android` (beside vyre-signer). Expo
   autolinking finds `expo-module.config.json` there and adds the Gradle project. A `file:`
   dependency in apps/app/package.json also works, but it needs a package.json in this folder
   first.
2. Import it only from native code, as `src/auth/person.native.ts` imports vyre-signer:
   `import * as Autofill from "../../modules/vault-android";`
3. `npx expo prebuild --platform android` (or the next EAS build). The library manifest merges
   both services, both activities and the INTERNET and USE_BIOMETRIC permissions into the app.
   The app's compileSdk must be 34 or later (androidx.credentials 1.3.0).
4. `res/xml/vyre_autofill.xml` names `sh.vyre.app.MainActivity` as the settings activity. If
   app.json's android.package changes, change it there too.
5. The unit tests run with the app's Gradle:
   `cd apps/app/android && ./gradlew :vault-android:testDebugUnitTest` (the project name is the
   folder name Expo autolinking gives it).
6. A screen in the app: server address, pairing code (`vyre vault pair --phone`), a name, then
   `pair`, then `openSettings()` until `isEnabled()` is true. On Android 14 the person also turns
   Vyre on under Settings, Passwords and accounts, for Credential Manager; the module does not open
   that screen yet.
7. Refresh res/raw/vyre_privileged_browsers.json from Google's URL above now and then.

## Done, and not yet

Done:

- **Phone pairing.** `vyre vault pair --phone` makes a code that accepts a device key, and a pair
  request with a key may come without an extension Origin. A browser code with a key is refused.
- **Native apps** match on `android://<package>@<sha256>` for match, fill and otp: a login must
  list `android:<package>@<sha256>` in its `apps`.
- **Credential Manager** (CredentialProviderService, Android 14 and later): passwords and passkeys,
  sign in and create, as above.

Not yet:

- save, card.fill and address.fill stay web-only in vyred, so an app cannot save a login or take
  a card or an address.
- **Reaching vyred.** The fill listener binds loopback and refuses a Host it does not know. The
  phone reaches it through `tailscale serve` (https) with that name in the listener's `names`.
- **Credential Manager polish:** a Vyre icon on entries, last-used times, the passkey error names
  (InvalidStateError for an excluded credential comes back as an unknown error with vyred's
  message), and a button in the app that opens the Credential Manager setting.
- **Inline suggestions polish:** icons, pinned "Vyre" chip, and a chip for an unpaired phone.
- **Tests on a real device.** Nothing in this folder has run on a phone or an emulator: Chrome
  native autofill, Firefox, Samsung Internet, compatibility mode, StrongBox fallback, the 2.8
  second budget on a slow network, and every Credential Manager path (in particular whether
  Chrome takes the provider's clientDataJSON placeholder when it gave the hash) all need a device.
