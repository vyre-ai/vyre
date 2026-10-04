#!/usr/bin/env bash
# Run the Android APK on this Mac, in an emulator (RC1 launch: Android is an APK on the person's Mac). The APK itself is built on a Linux box (scripts/android-apk.sh).
#
#   scripts/android-mac.sh setup            install the emulator once: JDK 17, the command line tools and one arm64 system image through Homebrew, and one AVD named vyre-pixel
#   scripts/android-mac.sh install [APK]    start the emulator (if it is not running) and install the APK (default ./dist-android/vyre-release.apk) with adb
#   scripts/android-mac.sh stop             shut the emulator down
#
# Everything lives under $HOME/vyre-android-sdk (about 6 GB with the system image; the Mac's disk is tight, `rm -rf` that folder to undo it). It does not install or start Vyre itself
# and never reads ~/.vyre, sessions or env files. Needs an Apple silicon Mac (the arm64 image runs natively; an Intel Mac would need x86_64).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(uname -s)" = "Darwin" ] || { echo "android-mac: this script is for the Mac" >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "android-mac: this script installs the arm64 system image; use an x86_64 image on an Intel Mac" >&2; exit 1; }

SDK=$HOME/vyre-android-sdk; AVD=vyre-pixel; IMAGE="system-images;android-35;google_apis;arm64-v8a"
export ANDROID_HOME=$SDK ANDROID_SDK_ROOT=$SDK ANDROID_AVD_HOME=$SDK/avd
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17 2>/dev/null || echo "$(brew --prefix openjdk@17 2>/dev/null)/libexec/openjdk.jdk/Contents/Home")}
export PATH=$JAVA_HOME/bin:$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH

setup() {
  command -v brew >/dev/null || { echo "android-mac: Homebrew is not installed" >&2; exit 1; }
  [ -x "$JAVA_HOME/bin/java" ] || { brew install openjdk@17; export JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"; export PATH=$JAVA_HOME/bin:$PATH; }
  if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    brew list --cask android-commandlinetools >/dev/null 2>&1 || brew install --cask android-commandlinetools
    # The cask keeps the tools under its own prefix; the SDK root here is ours, so sdkmanager is run with --sdk_root and the tools are copied in.
    src=$(brew --prefix)/share/android-commandlinetools/cmdline-tools/latest
    [ -d "$src" ] || src=$(brew --prefix)/Caskroom/android-commandlinetools/*/cmdline-tools
    mkdir -p "$SDK/cmdline-tools"; rm -rf "$SDK/cmdline-tools/latest"; cp -R $src "$SDK/cmdline-tools/latest"
  fi
  yes | sdkmanager --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true
  sdkmanager --sdk_root="$SDK" --install "platform-tools" "emulator" "$IMAGE"
  mkdir -p "$ANDROID_AVD_HOME"
  if ! avdmanager list avd | grep -q "Name: $AVD"; then
    echo no | avdmanager create avd -n "$AVD" -k "$IMAGE" -d pixel_8 --force
  fi
  echo "ready. Next: scripts/android-mac.sh install"
}

running() { adb devices 2>/dev/null | grep -q '^emulator-.*device$'; }

install() {
  local apk=${1:-dist-android/vyre-release.apk}
  [ -f "$apk" ] || { echo "android-mac: no APK at $apk (build it with scripts/android-apk.sh --remote <host>)" >&2; exit 1; }
  command -v emulator >/dev/null || { echo "android-mac: run scripts/android-mac.sh setup first" >&2; exit 1; }
  if ! running; then
    nohup emulator -avd "$AVD" -no-snapshot-save -no-boot-anim -gpu auto >"$SDK/emulator.log" 2>&1 &
    echo "starting the emulator"
    adb wait-for-device
    until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done
  fi
  adb install -r "$apk"
  adb shell monkey -p sh.vyre.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 || true
  echo "installed sh.vyre.app"
}

stop() { adb -e emu kill 2>/dev/null || true; }

case "${1:-}" in setup) setup ;; install) install "${2:-}" ;; stop) stop ;; *) echo "usage: $0 setup | install [APK] | stop" >&2; exit 2 ;; esac
