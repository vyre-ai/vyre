# Putting the phone apps on real phones

The phone apps are the one Expo app in `apps/app` (ADR 0027). The old SwiftUI and Compose apps
(`apps/ios`, `apps/android`) are deleted. Real-device installs, TestFlight and the Play Store are
the owner's to do: they need the owner's Apple and Google accounts, signing keys and a real box.
Nothing here is run by an agent.

Before any of it: the box must be reachable from the phone (the Wink code or the tailnet), and the
box must have a passkey, because the phone's key is approved once with it.

## Build

`apps/app/README.md` has the commands. `expo prebuild` writes `apps/app/ios` and `apps/app/android`
(never committed); `.github/workflows/android-app.yml` builds the debug APK and `release.yml`
signs the release one.

## iPhone
- Needs a Mac with Xcode 26, a paid Apple Developer account for TestFlight and push (a free one
  installs for 7 days, without push).
- Register `sh.vyre.app`, `sh.vyre.app.notify` and `sh.vyre.app.share`; turn on Push Notifications
  on `sh.vyre.app`; make an APNs key (.p8) and note its Key ID and Team ID.
- Set the team and entitlements in the Expo config (`apps/app/app.config.js`), run `expo prebuild`,
  open `apps/app/ios/*.xcworkspace`, pick the phone, press Run. Trust the developer on first launch
  (Settings, General, VPN and Device Management).
- TestFlight: create the app in App Store Connect with bundle ID `sh.vyre.app`, Product, Archive,
  Distribute App, then add yourself under Internal Testing.
- Push needs the box's native push transport (ADR 0018 section 4): put the APNs key in the Vault
  as `push-apns` (the .p8 contents, Key ID, Team ID, bundle ID), granted to module `push` only.

## Android
- JDK 17 and the Android SDK (platform 34); a phone with USB debugging, a screen lock and a fingerprint.
- `expo prebuild`, then `cd apps/app/android && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew assembleDebug`
  and `adb install -r` the APK. Releases are signed by `release.yml` with the upload key kept
  outside the repo (`keytool -genkeypair -v -keystore ~/vyre-upload.jks -alias vyre -keyalg RSA -keysize 4096 -validity 10000`).
- Push: a Firebase project with package `sh.vyre.app`, `google-services.json` kept out of git, build
  with `-Pvyre.fcm=true`; the service account key goes in the Vault as `push-fcm`, granted to module `push` only.
- Play Store: create the app, fill the listing, rating and data safety form (the app talks only to
  your own box), upload the bundle to Internal testing first.

## Store builds for other people
Anyone else's phone would need push through a relay run by Vyre AI, or each owner building the
app themselves. That is an open decision (ADR 0018 section 4), so store builds today are for the
owner's own phones.
