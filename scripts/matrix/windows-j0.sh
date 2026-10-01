#!/bin/sh
# windows-j0.sh: J0 in Chrome on Windows 11, against the box on this runner. Windows 11 runs in
# Docker (dockur/windows, QEMU on KVM), installed unattended from Microsoft's own download; the
# OEM script (windows/oem/install.bat) installs Chrome and points the guest's 127.0.0.1:7300 at
# the box through a relay on the runner. CI runners only.
set -u
[ -n "${CI:-}" ] || { echo "windows-j0.sh: runs on a CI runner only" >&2; exit 2; }
HERE=$(cd "$(dirname "$0")" && pwd)
sudo apt-get -qq install -y socat >/dev/null 2>&1
socat TCP-LISTEN:17300,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:7300 &
sudo mkdir -p /mnt/win && sudo chmod 777 /mnt/win
t0=$(date +%s)
docker run -d --name win -e VERSION=11 -e DISK_SIZE=48G -e RAM_SIZE=8G -e CPU_CORES=3 -e USER_PORTS=9223 \
  --device /dev/kvm --device /dev/net/tun --cap-add NET_ADMIN -p 127.0.0.1:8006:8006 -p 127.0.0.1:9223:9223 \
  -v /mnt/win:/storage -v "$HERE/windows/oem":/oem:ro --stop-timeout 60 dockurr/windows >/dev/null
ok=0
for i in $(seq 1 150); do
  if curl -fs -m 3 http://127.0.0.1:9223/json/version >/dev/null 2>&1; then ok=1; break; fi
  sleep 20
done
echo "windows: Chrome's DevTools answer after $(( $(date +%s) - t0 )) s (ready=$ok)"
if [ $ok = 0 ]; then docker logs win 2>&1 | tail -20; exit 1; fi
curl -fs http://127.0.0.1:9223/json/version | head -c 300; echo
sh "$HERE/new-link.sh" link-windows.txt
node "$HERE/j0.mjs" --cdp http://127.0.0.1:9223 --link-file link-windows.txt --device windows11-chrome --out results/windows --native
