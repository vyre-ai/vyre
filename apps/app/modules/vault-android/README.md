# vault-android: Vyre autofill on Android

An Expo local module that makes Vyre an Android autofill service (ADR 0028, decision 6). It
fills logins, one-time codes, cards and addresses into apps and browsers from vyred's fill
listener (core/vault/fill.js), and offers to save a login someone types.

Android only. The web and iOS builds never import it.

## What is in it

```
modules/vault-android/
  expo-module.config.json        android: sh.vyre.autofill.VyreAutofillModule
  index.ts                       the app's JS API
  android/build.gradle           namespace sh.vyre.autofill
  android/src/main/AndroidManifest.xml
  android/src/main/res/xml/vyre_autofill.xml          service metadata, compatibility packages
  android/src/main/res/layout/vyre_autofill_item.xml  one suggestion: a name, never a value
  android/src/main/res/values/vyre_autofill.xml       label, translucent theme
  android/src/main/java/sh/vyre/autofill/
    AutofillCore.kt          pure Kotlin: classification, origins, challenge, server URL
    StructureReader.kt       AssistStructure to fields and one origin
    FillClient.kt            the fill listener's HTTP client
    VaultStore.kt            encrypted prefs, the in-memory session, the device key
    Datasets.kt              locked suggestions, inline chips, the filled Dataset
    VyreAutofillService.kt   onFillRequest, onSaveRequest
    VyreAuthActivity.kt      biometric unlock, fetch, hand back the Dataset
    VyreAutofillModule.kt    the Expo module
  android/src/test/java/sh/vyre/autofill/AutofillCoreTest.kt   plain JVM JUnit
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

## How mobile includes it

1. Copy or symlink this folder to `apps/app/modules/vault-android` (beside vyre-signer). Expo
   autolinking finds `expo-module.config.json` there and adds the Gradle project. A `file:`
   dependency in apps/app/package.json also works, but it needs a package.json in this folder
   first.
2. Import it only from native code, as `src/auth/person.native.ts` imports vyre-signer:
   `import * as Autofill from "../../modules/vault-android";`
3. `npx expo prebuild --platform android` (or the next EAS build). The library manifest merges
   the service, the auth activity and the INTERNET and USE_BIOMETRIC permissions into the app.
4. `res/xml/vyre_autofill.xml` names `sh.vyre.app.MainActivity` as the settings activity. If
   app.json's android.package changes, change it there too.
5. The unit tests run with the app's Gradle:
   `cd apps/app/android && ./gradlew :vault-android:testDebugUnitTest` (the project name is the
   folder name Expo autolinking gives it).
6. A screen in the app: server address, pairing code, a name, then `pair`, then
   `openSettings()` until `isEnabled()` is true.

## Not done yet

- **Pairing needs a phone code.** Run `vyre vault pair --phone` (it asks for Touch ID): only a
  phone code accepts a device key, and only a pair request with a key may come without an
  extension Origin. A browser code with a key is refused.
- **Native apps** match on `android://<package>@<sha256>` for match, fill and otp: a login must
  list `android:<package>@<sha256>` in its `apps`. save, card.fill and address.fill stay web-only.
- **Reaching vyred.** The fill listener binds loopback and refuses a Host it does not know. The
  phone reaches it through `tailscale serve` (https) with that name in the listener's `names`.
- **CredentialProviderService** for passwords and passkeys in Credential Manager (Android 14 and
  later). Passkeys (`passkeys`, `passkey.get`) are not wired here.
- **Inline suggestions polish:** icons, pinned "Vyre" chip, and a chip for an unpaired phone.
- **Tests on a real device.** Nothing in this folder has run on a phone or an emulator: Chrome
  native autofill, Firefox, Samsung Internet, compatibility mode, StrongBox fallback, and the
  2.8 second budget on a slow network all need a device.
