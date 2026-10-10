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
sleep 45
adb install -r -g "$apk" || { echo "install failed"; exit 1; }
adb logcat -c
adb shell am force-stop sh.vyre.app
adb shell am start -W -a android.intent.action.VIEW -p sh.vyre.app -d "vyre://glass-relay-proof" >"$out/start.txt" 2>&1 || true
share=0
for i in $(seq 1 12); do
  sleep 5
  adb exec-out screencap -p >"$out/glass-$i.png"
  share=$(node "$here/png-grey.mjs" "$out/glass-$i.png" 2>/dev/null || echo 0)
  echo "after $((i * 5)) s: grey share $share"
  # a frame is on screen when the screen's grey fills a real part of it
  if awk "BEGIN{exit !($share >= 0.05)}"; then break; fi
done
cp "$out/glass-$i.png" "$out/glass-frame.png"
adb logcat -d -v time -s ReactNativeJS:V AndroidRuntime:E >"$out/logcat-js.txt" 2>&1 || true
grep -c "watcher connected" "$out/world.log" >"$out/connections.txt" || true
echo "grey share $share; the fake screen server saw $(cat "$out/connections.txt") connection(s)"
awk "BEGIN{exit !($share >= 0.05)}" || { echo "no frame was drawn"; exit 1; }
echo "a frame was drawn by the phone's Glass page in relay mode"
