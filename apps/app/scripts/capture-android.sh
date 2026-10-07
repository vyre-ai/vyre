#!/usr/bin/env bash
# Runs inside an Android emulator (reactivecircus/android-emulator-runner): installs the debug APK, opens the
# screens through their vyre:// links, and keeps screenshots, a short screen recording and the log.
#   capture-android.sh <apk> <out dir>
set -u
apk=$1; out=$2; mkdir -p "$out"
adb wait-for-device
# Animations stay on: with them off the app reads "reduce motion" and a motion bug of the app (see the capture notes) hides everything else.
sleep 45
adb install -r -g "$apk" || { echo "install failed"; exit 1; }
adb logcat -c

open() { # name, url, seconds to wait
  adb shell am start -W -a android.intent.action.VIEW -p sh.vyre.app -d "$2" >"$out/$1.start.txt" 2>&1 || true
  sleep "$3"
  adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
  sleep 2
  adb exec-out screencap -p >"$out/$1.png"
  echo "$1: $2 ($(stat -c %s "$out/$1.png") bytes)"
}

adb shell am force-stop sh.vyre.app
# The first start loads the JavaScript bundle: give it time.
open now "vyre://u/now" 30
open record "vyre://u/record/01a05a43-fc00-4f98-ad05-d023d68e45fe" 10
open chat "vyre://chat-demo?at=4200&hold=1" 10
open now-again "vyre://u/now" 8
# The second card in full view ("Fix"), by the deep link's scroll offset (dp; honoured only in a mock build).
open now-card2 "vyre://u/now?scroll=430" 10

# The other theme: the app follows the system night mode.
adb shell cmd uimode night yes; sleep 3
open now-dark "vyre://u/now" 10
open now-card2-dark "vyre://u/now?scroll=430" 10
open chat-dark "vyre://chat-demo?at=4200&hold=1" 10
adb shell cmd uimode night no; sleep 3
open now "vyre://u/now" 8

# A short recording of Now, scrolled a little.
adb shell "screenrecord --time-limit 12 /sdcard/now.mp4" &
rec=$!
sleep 2
for _ in 1 2 3; do adb shell input swipe 540 1700 540 600 400; sleep 1; done
for _ in 1 2; do adb shell input swipe 540 600 540 1700 400; sleep 1; done
wait "$rec" || true
adb pull /sdcard/now.mp4 "$out/now.mp4" || true

adb logcat -d -v time '*:W' >"$out/logcat-warn.txt" 2>&1 || true
adb logcat -d -v time -s ReactNativeJS:V AndroidRuntime:E 'DEBUG:*' >"$out/logcat-js.txt" 2>&1 || true
adb shell dumpsys activity activities | grep -m3 -E "mResumedActivity|topResumedActivity" >"$out/resumed.txt" || true
cat "$out/resumed.txt"
