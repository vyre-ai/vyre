#!/usr/bin/env bash
# Runs inside an Android emulator (reactivecircus/android-emulator-runner): the phone's Glass page in relay mode, in the real WebView. A fake screen server runs on this machine (glass-relay-world.mjs); the app's proof
# route (vyre://glass-relay-proof) opens the bundled page, its WebSocket shim and bridge reach the server as 10.0.2.2:5999, and noVNC draws the server's grey screen. The screenshot must be mostly that grey.
#   glass-relay-android.sh <apk> <out dir>
set -u
apk=$1; out=$2; mkdir -p "$out"
here=$(cd "$(dirname "$0")" && pwd)
node "$here/glass-relay-world.mjs" >"$out/world.log" 2>&1 &
world=$!
trap 'kill $world 2>/dev/null' EXIT
for _ in $(seq 1 20); do grep -q READY "$out/world.log" && break; sleep 1; done
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
# a loaded hosted emulator makes the launcher miss its deadline: no "isn't responding" dialog may sit over the app
adb shell settings put global hide_error_dialogs 1
sleep 45
adb install -r -g "$apk" || { echo "install failed"; exit 1; }
adb logcat -c
adb shell am force-stop sh.vyre.app
try_host() { # name, link, adb reverse?
  adb shell am force-stop sh.vyre.app
  [ "$3" = reverse ] && adb reverse tcp:5999 tcp:5999
  adb shell am start -W -a android.intent.action.VIEW -p sh.vyre.app -d "$2" >"$out/start-$1.txt" 2>&1 || true
  for i in $(seq 1 8); do
    sleep 5
    adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
    adb shell dumpsys activity activities | grep -m1 -E "mResumedActivity|topResumedActivity" | grep -q sh.vyre.app || adb shell am start -a android.intent.action.VIEW -p sh.vyre.app -d "$2" >/dev/null 2>&1 || true
    adb exec-out screencap -p >"$out/glass-$1-$i.png"
    share=$(node "$here/png-grey.mjs" "$out/glass-$1-$i.png" 2>/dev/null || echo 0)
    echo "$1, after $((i * 5)) s: grey share $share"
    if awk "BEGIN{exit !($share >= 0.05)}"; then cp "$out/glass-$1-$i.png" "$out/glass-frame.png"; return 0; fi
  done
  cp "$out/glass-$1-8.png" "$out/glass-last-$1.png"
  return 1
}
share=0
ok=1
try_host emulator-host "vyre://glass-relay-proof" no && ok=0
[ $ok = 1 ] && try_host reverse "vyre://glass-relay-proof?h=127.0.0.1:5999" reverse && ok=0
adb logcat -d -v time -s ReactNativeJS:V AndroidRuntime:E >"$out/logcat-js.txt" 2>&1 || true
grep -c "watcher connected" "$out/world.log" >"$out/connections.txt" || true
echo "the fake screen server saw $(cat "$out/connections.txt") connection(s)"
[ $ok = 0 ] || { echo "no frame was drawn"; exit 1; }
echo "a frame was drawn by the phone's Glass page in relay mode"
# run on the APK with the reason shown
# rerun on the build with the richer proof page
# rerun with the cleartext flag read at prebuild
# rerun with socket diagnostics
# rerun with GlassFrame taking openSocket
