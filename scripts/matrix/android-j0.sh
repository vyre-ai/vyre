#!/bin/sh
# android-j0.sh: J0 in Chrome on the Android emulator, against the box on this runner. The
# emulator reaches the box as 127.0.0.1:7300 (adb reverse), the only Host the onboarding takes.
# Chrome's first-run screen is turned off (a person's first run is walked by hand once).
set -u
adb reverse tcp:7300 tcp:7300
adb shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
adb shell am set-debug-app --persistent com.android.chrome >/dev/null
adb shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell am force-stop com.android.chrome
adb shell am start -a android.intent.action.VIEW -d about:blank com.android.chrome >/dev/null
adb forward tcp:9223 localabstract:chrome_devtools_remote
for i in $(seq 1 60); do curl -fs http://127.0.0.1:9223/json/version >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:9223/json/version | head -c 300; echo
sh scripts/matrix/new-link.sh link-android.txt
node scripts/matrix/j0.mjs --cdp http://127.0.0.1:9223 --link-file link-android.txt --device android-chrome --out results/android --native
rc=$?
mkdir -p results/android/J0/02-screen && adb exec-out screencap -p > results/android/J0/02-screen/android-chrome.png
exit $rc
