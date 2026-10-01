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

# swtpm runs under an AppArmor profile that would deny its state and log under /srv/vyre-test.
grep -qs "/srv/vyre-test/win11" /etc/apparmor.d/local/usr.bin.swtpm 2>/dev/null || {
  echo "/srv/vyre-test/win11/** rwk," | sudo tee -a /etc/apparmor.d/local/usr.bin.swtpm >/dev/null
  sudo apparmor_parser -r /etc/apparmor.d/usr.bin.swtpm || true
}
# wsgidav for the Drive net-use test, and sshpass for g.sh
command -v sshpass >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y sshpass python3-venv >/dev/null
[ -x "$ROOT/venv/bin/wsgidav" ] || { python3 -m venv "$ROOT/venv" && "$ROOT/venv/bin/pip" install -q wsgidav cheroot; }

mkdir -p "$ROOT/share/release"; [ -s "$ROOT/share/release/OpenSSH-Win64.zip" ] || curl -sL --fail -o "$ROOT/share/release/OpenSSH-Win64.zip" https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip
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
cp "$here/start.sh" "$here/stop.sh" "$here/swap.sh" "$here/g.sh" "$here/type.py" "$ROOT/"; chmod +x "$ROOT/start.sh" "$ROOT/stop.sh" "$ROOT/swap.sh" "$ROOT/g.sh"
echo "ready: $ROOT (start with: sh $ROOT/start.sh install   then   sh $ROOT/start.sh)"
