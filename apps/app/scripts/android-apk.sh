#!/usr/bin/env bash
# Build the Android app as a release APK on a Linux box (JDK 17 and the Android SDK live there, never on the Mac), signed with a local key that stays out of git.
#
#   scripts/android-apk.sh                 on the Linux box itself: install the toolchain once, build, print the APK path
#   scripts/android-apk.sh --remote HOST   from the repo: sync this app to HOST (an ssh alias), build there, copy the APK to ./dist-android/vyre-release.apk
#
# The toolchain (Temurin 17, command line tools, platform 36, build tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1) goes under $HOME/vyre-android-toolchain, and the signing key under
# $HOME/vyre-android-keys (made once, mode 600). Neither is in the repo. The APK is arm64-v8a only (phones and the Apple silicon emulator). Release builds carry their JavaScript bundle.
# This is a sideload build: the key is a local one, not the release key (release.yml signs the real one).
set -euo pipefail

if [ "${1:-}" = "--remote" ]; then
  host=${2:?usage: $0 --remote HOST}
  root=$(cd "$(dirname "$0")/../../.." && pwd)
  ssh "$host" 'mkdir -p ~/vyre-ci/apk'
  nice -n 10 rsync -a --delete --exclude node_modules --exclude .git --exclude '/apps/app/android' --exclude '/apps/app/ios' --exclude '.expo' --exclude 'dist-android' "$root"/ "$host":~/vyre-ci/apk/
  ssh "$host" 'cd ~/vyre-ci/apk/apps/app && bash scripts/android-apk.sh' | tee /dev/stderr | tail -1 > /dev/null
  mkdir -p "$(dirname "$0")/../dist-android"
  scp -q "$host":~/vyre-ci/apk/apps/app/dist-android/vyre-release.apk "$(dirname "$0")/../dist-android/vyre-release.apk"
  echo "copied to apps/app/dist-android/vyre-release.apk"
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || { echo "android-apk: run this on a Linux box (or use --remote HOST); the Mac does not build Android" >&2; exit 1; }
cd "$(dirname "$0")/.."
TC=$HOME/vyre-android-toolchain; KEYS=$HOME/vyre-android-keys
mkdir -p "$TC" "$KEYS"; chmod 700 "$KEYS"
export JAVA_HOME=$TC/jdk17 ANDROID_HOME=$TC/sdk ANDROID_SDK_ROOT=$TC/sdk EXPO_NO_TELEMETRY=1
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH
unset EXPO_PUBLIC_VYRE_MOCK

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "installing JDK 17"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse" -o "$TC/jdk17.tgz"
  mkdir -p "$JAVA_HOME"; tar -xzf "$TC/jdk17.tgz" -C "$JAVA_HOME" --strip-components=1; rm -f "$TC/jdk17.tgz"
fi
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "installing the Android command line tools"
  curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" -o "$TC/cmdline.zip"
  mkdir -p "$ANDROID_HOME/cmdline-tools"; unzip -q -o "$TC/cmdline.zip" -d "$TC/cl"; rm -rf "$ANDROID_HOME/cmdline-tools/latest"; mv "$TC/cl/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"; rm -rf "$TC/cl" "$TC/cmdline.zip"
fi
yes | sdkmanager --licenses >/dev/null 2>&1 || true
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1" >/dev/null

if [ ! -f "$KEYS/sideload.keystore" ]; then
  echo "making the local signing key"
  pw=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  keytool -genkeypair -keystore "$KEYS/sideload.keystore" -storepass "$pw" -keypass "$pw" -alias vyre-sideload -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Vyre sideload" >/dev/null
  printf 'storepass=%s\n' "$pw" > "$KEYS/sideload.properties"; chmod 600 "$KEYS/sideload.keystore" "$KEYS/sideload.properties"
fi
pw=$(sed -n 's/^storepass=//p' "$KEYS/sideload.properties")

[ -d node_modules ] || npm ci --no-audit --no-fund
npx expo prebuild -p android --no-install --clean

# Sign the release variant with the local key: the template signs release with the debug key, so point its signingConfig at ours through gradle properties.
g=android/app/build.gradle
python3 - "$g" <<'PY'
import sys,re
p=sys.argv[1]; s=open(p).read()
if "vyreSideload" not in s:
    s=s.replace("signingConfigs {","signingConfigs {\n        vyreSideload {\n            storeFile file(System.getenv('VYRE_KEYSTORE'))\n            storePassword System.getenv('VYRE_STOREPASS')\n            keyAlias 'vyre-sideload'\n            keyPassword System.getenv('VYRE_STOREPASS')\n        }",1)
    i=s.index("buildTypes {"); j=s.index("release {",i)
    k=s.index("signingConfig",j)
    e=s.index("\n",k)
    s=s[:k]+"signingConfig signingConfigs.vyreSideload"+s[e:]
open(p,'w').write(s)
PY
grep -q "signingConfigs.vyreSideload" "$g" || { echo "android-apk: could not point the release build at the local key" >&2; exit 1; }
export VYRE_KEYSTORE=$KEYS/sideload.keystore VYRE_STOREPASS=$pw
# The box is shared and small: cap gradle's and kotlin's memory and workers so the daemon is not killed (it was, once, at the default sizes).
(cd android && nice -n 10 ./gradlew --no-daemon --max-workers=2 -Dorg.gradle.jvmargs='-Xmx2g -XX:MaxMetaspaceSize=512m' -Pkotlin.daemon.jvmargs=-Xmx1g -Pkotlin.compiler.execution.strategy=in-process -PreactNativeArchitectures=arm64-v8a assembleRelease)

apk=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
mkdir -p dist-android; cp "$apk" dist-android/vyre-release.apk
bt=$ANDROID_HOME/build-tools/36.0.0
"$bt/aapt2" dump badging dist-android/vyre-release.apk | sed -n "s/^package: name='\([^']*\)' versionCode='\([^']*\)' versionName='\([^']*\)'.*/package \1 versionCode \2 versionName \3/p"
"$bt/apksigner" verify --print-certs dist-android/vyre-release.apk | head -2
node scripts/check-android-permissions.mjs --apk dist-android/vyre-release.apk || true
node scripts/check-apk-nothing-central.mjs --apk dist-android/vyre-release.apk
sha256sum dist-android/vyre-release.apk
echo "$PWD/dist-android/vyre-release.apk"
