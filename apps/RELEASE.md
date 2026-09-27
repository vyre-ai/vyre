# Putting the phone apps on real phones

Real-device installs, TestFlight and the Play Store are the owner's to do: they need the owner's
Apple and Google accounts, signing keys and a real box. Nothing here is run by an agent. Every
step below uses the fictional sample world only as an example (alex, Harlow Legal).

Before any of it: the box must be reachable from the phone over the tailnet (the Tailscale app
signed in on the phone, the box's name opening the Deck in the phone's browser), and the Deck
must have a passkey, because the phone's key is approved once with it.

## iPhone

### What you need
- A Mac with Xcode 26 and XcodeGen (`brew install xcodegen`).
- An Apple Developer account (paid, for TestFlight and push; a free account can install on your
  own phone for 7 days, without push).
- Your iPhone with Developer Mode on (Settings, Privacy and Security, Developer Mode).

### One-time setup in the Apple Developer site
1. Identifiers: register `sh.vyre.app`, `sh.vyre.app.notify` and `sh.vyre.app.share` (or your
   own prefix; change `bundleIdPrefix` and the three `PRODUCT_BUNDLE_IDENTIFIER`s in
   `apps/ios/project.yml` to match).
2. On `sh.vyre.app`: turn on Push Notifications. The app and the notification extension share
   the push key through a keychain group, which needs no registration.
3. Keys: create an APNs key (.p8). Note its Key ID and your Team ID. This key is what lets your
   box send pushes to your phone.

### Signing
1. In `apps/ios/project.yml`, set `DEVELOPMENT_TEAM` to your Team ID and `CODE_SIGN_STYLE` to
   `Automatic`.
2. Add to `apps/ios/Vyre/Vyre.entitlements` and `apps/ios/VyreNotify/VyreNotify.entitlements`:
   `aps-environment` (`development` for a cable install, `production` for TestFlight) on the app,
   and `keychain-access-groups` with `$(AppIdentifierPrefix)sh.vyre.app.shared` on the app and
   the notification extension (`Shared/Keychain.swift` looks for exactly that group).
   These are left empty in the repo so that unsigned simulator builds work.
3. `cd apps/ios && xcodegen generate && open Vyre.xcodeproj`.

### Install on your own phone
1. Plug the phone in, pick it as the run destination, choose the Release scheme configuration if
   you want the build without the test-world button, and press Run.
2. The first launch asks you to trust the developer: Settings, General, VPN and Device Management.
3. In the app, type the box's name (for example `vyre.your-tailnet.ts.net`) and sign in. The
   Deck's sign-in page opens; approve with the Deck's passkey. Face ID then guards approvals and
   the Vault on this phone.

### TestFlight
1. In App Store Connect, create the app with bundle ID `sh.vyre.app`.
2. In Xcode: Product, Archive, then Distribute App, App Store Connect, Upload.
3. When processing finishes, add yourself under TestFlight, Internal Testing, and install from the
   TestFlight app. Internal testers need no review.

### Push on iPhone
Push needs the box's native push transport (ADR 0018 section 4; not yet on main). Once it is:
put the APNs key in the Vault as `push-apns` (the .p8 contents, Key ID, Team ID and bundle ID),
granted to module `push` only. The app registers itself when you allow notifications.

## Android

### What you need
- JDK 17 and the Android SDK (platform 34). `apps/android/local.properties` points at the SDK.
- An Android phone with USB debugging on (Settings, About phone, tap Build number 7 times, then
  Developer options, USB debugging). A screen lock and a fingerprint set up on it: the app's key
  needs both.

### Install on your own phone
1. `cd apps/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew assembleRelease` after
   setting up signing (below), or `assembleDebug` for a quick try (the debug build also offers the
   test world).
2. `adb install -r app/build/outputs/apk/release/app-release.apk`.
3. Open Vyre, type the box's name, sign in with the Deck's passkey in the browser that opens.

### Signing a release
1. Make an upload key once and keep it safe (outside the repo, backed up):
   `keytool -genkeypair -v -keystore ~/vyre-upload.jks -alias vyre -keyalg RSA -keysize 4096 -validity 10000`
2. Add a `signingConfigs { create("release") { ... } }` block to `apps/android/app/build.gradle.kts`
   reading the path and passwords from `~/.gradle/gradle.properties` (never commit them), and set
   `signingConfig = signingConfigs.getByName("release")` on the release build type.

### Push on Android
1. Create a Firebase project, add an Android app with package `sh.vyre.app`, download
   `google-services.json` into `apps/android/app/`. It stays out of git.
2. Build with `-Pvyre.fcm=true`. Without it the app has no Play services code and no push.
3. Once the box's FCM transport is on main: make a Firebase service account key and put it in the
   Vault as `push-fcm`, granted to module `push` only.

### Play Store
1. In Play Console, create the app, fill in the store listing, content rating and data safety
   form (the app talks only to your own box; it collects nothing for Vyre).
2. `./gradlew bundleRelease` and upload `app/build/outputs/bundle/release/app-release.aab` to the
   Internal testing track first. Add yourself as a tester and install from the opt-in link.
3. Promote to production when ready. Play App Signing keeps the app signing key; your upload key
   only signs uploads.

## Store builds for other people
Anyone else's phone would need push through a relay run by Vyre AI, or each owner building the
app themselves. That is an open decision (ADR 0018 section 4), so store builds today are for the
owner's own phones.
