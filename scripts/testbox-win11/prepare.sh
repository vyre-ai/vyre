#!/bin/sh
# One-time setup of the Windows 11 test VM on the testbox. Everything lives under /srv/vyre-test/win11;
# nothing is touched under /srv/vyre (the live box). Safe to re-run: each step skips what exists.
#   sh prepare.sh            install packages, fetch the ISOs, build the unattended-install disc
set -eu
ROOT=/srv/vyre-test/win11
ISO_URL="${WIN11_ISO_URL:-https://go.microsoft.com/fwlink/?linkid=2289031&clcid=0x409&culture=en-us&country=us}"   # Windows 11 Enterprise evaluation, x64, en-us (free, 90 days, for testing)
VIRTIO_URL="https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso"
here="$(cd "$(dirname "$0")" && pwd)"

sudo mkdir -p "$ROOT"; sudo chown "$(id -u):$(id -g)" /srv/vyre-test "$ROOT"
mkdir -p "$ROOT/iso" "$ROOT/run" "$ROOT/tpm" "$ROOT/logs" "$ROOT/secrets" "$ROOT/share"
chmod 700 "$ROOT/secrets"

if ! command -v qemu-system-x86_64 >/dev/null || ! command -v swtpm >/dev/null || ! ls /usr/share/OVMF/OVMF_CODE*4M*.fd >/dev/null 2>&1 || ! command -v xorriso >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y qemu-system-x86 qemu-utils ovmf swtpm swtpm-tools xorriso
fi

[ -s "$ROOT/iso/win11.iso" ] || { curl -L --fail -o "$ROOT/iso/win11.iso.part" "$ISO_URL" && mv "$ROOT/iso/win11.iso.part" "$ROOT/iso/win11.iso"; }
[ -s "$ROOT/iso/virtio-win.iso" ] || { curl -L --fail -o "$ROOT/iso/virtio-win.iso.part" "$VIRTIO_URL" && mv "$ROOT/iso/virtio-win.iso.part" "$ROOT/iso/virtio-win.iso"; }

# The guest password: random, kept only here (0600), never printed or committed.
[ -s "$ROOT/secrets/vm-password" ] || { umask 077; head -c 18 /dev/urandom | base64 | tr -d '/+=' > "$ROOT/secrets/vm-password"; }
pw="$(cat "$ROOT/secrets/vm-password")"
mkdir -p "$ROOT/unattend"
sed "s/@PASSWORD@/$pw/g" "$here/autounattend.xml.in" > "$ROOT/unattend/autounattend.xml"
chmod 600 "$ROOT/unattend/autounattend.xml"
xorriso -as mkisofs -quiet -J -r -V UNATTEND -o "$ROOT/iso/unattend.iso" "$ROOT/unattend"

[ -f "$ROOT/disk.qcow2" ] || qemu-img create -f qcow2 "$ROOT/disk.qcow2" 64G
cp -n /usr/share/OVMF/OVMF_VARS_4M.fd "$ROOT/OVMF_VARS.fd" 2>/dev/null || cp -n /usr/share/OVMF/OVMF_VARS_4M.ms.fd "$ROOT/OVMF_VARS.fd"
cp "$here/start.sh" "$here/stop.sh" "$here/swap.sh" "$ROOT/"; chmod +x "$ROOT/start.sh" "$ROOT/stop.sh" "$ROOT/swap.sh"
echo "ready: $ROOT (start with: sh $ROOT/start.sh install   then   sh $ROOT/start.sh)"
