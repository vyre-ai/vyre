#!/usr/bin/env bash
# Runs inside an Android emulator (reactivecircus/android-emulator-runner): notices with the app closed. The proof route (vyre://notices-proof, sample world) turns the kept connection on, arms a scripted server answer and
# closes its own screen. With no screen, the foreground service's headless task must still be running the notice loop: the script waits for the notice the loop makes from the scripted approval and reads it from the phone.
#   notices-android.sh <apk> <out dir>
set -u
apk=$1; out=$2; mkdir -p "$out"
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
adb shell settings put global hide_error_dialogs 1
sleep 45
adb install -r -g "$apk" || { echo "install failed"; exit 1; }
adb shell pm grant sh.vyre.app android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb logcat -c
adb shell am force-stop sh.vyre.app
adb shell am start -W -a android.intent.action.VIEW -p sh.vyre.app -d "vyre://notices-proof" >"$out/start.txt" 2>&1 || true
# the screen closes itself a few seconds after the service is asked for
for i in $(seq 1 30); do sleep 2; adb logcat -d -s ReactNativeJS:V | grep -q "notices-proof armed" && break; done
sleep 12
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" >"$out/resumed.txt" || true
pid=$(adb shell pidof sh.vyre.app | tr -d '\r')
echo "app process: ${pid:-none}"; echo "resumed: $(cat "$out/resumed.txt")"
adb shell dumpsys activity services sh.vyre.app >"$out/services.txt" 2>&1
grep -q "KeepAliveService" "$out/services.txt" && echo "the foreground service is running" || echo "NO foreground service"
adb exec-out screencap -p >"$out/closed.png"
found=1
for i in $(seq 1 30); do
  sleep 5
  adb shell dumpsys notification --noredact >"$out/notifications.txt" 2>&1
  if grep -q "Proof: a call waits for your yes" "$out/notifications.txt"; then found=0; echo "the notice was made after $((i * 5)) s, with the app closed"; break; fi
done
adb logcat -d -v time -s ReactNativeJS:V AndroidRuntime:E >"$out/logcat-js.txt" 2>&1 || true
adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | grep -q sh.vyre.app && { echo "the app was still on screen: not a closed-app proof"; found=1; }
[ -n "${pid:-}" ] || { echo "the app process was gone"; found=1; }
[ $found = 0 ] && echo "PASS: a notice was made with the app closed" || echo "FAIL"
exit $found
