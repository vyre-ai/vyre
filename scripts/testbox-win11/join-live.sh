#!/bin/sh
# The companion join proof on the Win11 VM, run on the test box (needs the VM up: start.sh). It builds the app with --features selftest, runs a
# throwaway Vyre box from this tree on the real relay (box.mjs, BOX_REAL_PRESENCE=1), carries the pairing words from the VM to the box, and
# prints what the VM script (checks/join-live.ps1) and the box saw. Everything lives under /srv/vyre-test/winjoin, never /srv/vyre.
#   sh scripts/testbox-win11/join-live.sh <repo checkout> <vyre.tgz>
set -eu
REPO="$(cd "$1" && pwd)"; TGZ="$2"
R=/srv/vyre-test/win11; W=/srv/vyre-test/winjoin
export SSHPASS="$(cat $R/secrets/vm-password)"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=$R/run/known_hosts -P 2222"
mkdir -p "$W/repo" "$W/box"
rsync -a --delete --exclude .git --exclude node_modules --exclude target "$REPO"/ "$W/repo/"
rm -rf "$W/box/home" "$W/box/words.txt"
systemctl --user stop winjoin-box 2>/dev/null || true
systemd-run --user --unit=winjoin-box --collect --quiet --setenv=BOX="$W/box" --setenv=BOX_REAL_PRESENCE=1 -p StandardOutput=file:$W/box.log -p StandardError=file:$W/box.log nice -n 10 node "$W/repo/scripts/testbox-win11/box.mjs"
sleep 6
(cd "$W/repo/local/capsule/native-win/app" && mkdir -p ui/relay ui/vendor && for f in "$W"/repo/relay/client/*.js; do case "$f" in *.test.js|*/nodecrypto.js|*/testing.js) ;; *) cp "$f" ui/relay/ ;; esac; done && cp "$W/repo/deck/vendor/qrcode.js" ui/vendor/ \
  && VYRE_APP_VERSION=0.2.3-test.1 nice -n 15 "$HOME/.cargo/bin/cargo" tauri build --bundles nsis --target x86_64-pc-windows-gnu --features selftest -- --locked >"$W/build.log" 2>&1)
$SCP "$W/repo/local/capsule/native-win/app/target/x86_64-pc-windows-gnu/release/bundle/nsis/"Vyre_*_x64-setup.exe vyre@127.0.0.1:C:/vtest/Vyre_setup.exe
$SCP "$TGZ" vyre@127.0.0.1:C:/vtest/vyre.tgz
$SCP "$W/repo/scripts/testbox-win11/checks/join-live.ps1" vyre@127.0.0.1:C:/Users/vyre/join-live.ps1
cat > "$W/go.ps1" <<'P'
Remove-Item C:\Users\vyre\join.txt, C:\Users\vyre\words.txt -ErrorAction SilentlyContinue
Set-Content C:\joinlive.cmd "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\vyre\join-live.ps1" -Encoding ASCII
schtasks /create /tn joinlive /tr C:\joinlive.cmd /sc once /st 23:59 /it /f | Out-Null
schtasks /run /tn joinlive | Out-Null
P
sh $R/gf.sh "$W/go.ps1"
# carry the 13 words to the box, then wait for the VM script to finish
i=0
while [ $i -lt 100 ]; do
  w="$(sh $R/g.sh 'if (Test-Path C:\Users\vyre\words.txt) { Get-Content C:\Users\vyre\words.txt -Raw }' 2>/dev/null | tr -d '\r' | xargs || true)"
  if [ "$(echo $w | wc -w)" -ge 13 ] && [ ! -e "$W/box/.carried" ]; then printf '%s' "$w" > "$W/box/words.txt"; touch "$W/box/.carried"; echo "words carried to the box"; fi
  d="$(sh $R/g.sh 'if (Test-Path C:\Users\vyre\join.txt) { Get-Content C:\Users\vyre\join.txt -Raw }' 2>/dev/null | tr -d '\r' || true)"
  echo "$d" | grep -q ' done$' && break
  i=$((i+1)); sleep 6
done
echo "=== VM"; sh $R/g.sh 'Get-Content C:\Users\vyre\join.txt' | tr -d '\r'
echo "=== box"; grep -E "companion|device.paired|ticket|ERROR|failed" "$W/box.log" | cut -c1-260 | tail -20
rm -f "$W/box/.carried"
systemctl --user stop winjoin-box 2>/dev/null || true
sh $R/g.sh 'schtasks /delete /tn joinlive /f' >/dev/null 2>&1 || true
