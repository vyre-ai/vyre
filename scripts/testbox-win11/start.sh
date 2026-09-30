#!/bin/sh
# Start the Windows 11 VM (QEMU/KVM, UEFI, swtpm TPM 2.0, virtio). Never touches /srv/vyre.
#   start.sh install   first boot from the Windows disc with the unattended answer file
#   start.sh           normal boot from the disk
# Env: VM_MEM (MB; default 4096, or 6144 when more than 3 GB would stay free), VM_CPUS (default 4). Ports, all on 127.0.0.1 of the testbox:
#   ssh 2222 -> guest 22, rdp 3390 -> guest 3389, vnc 5901 (display :1). Reach them through ssh -L.
set -eu
ROOT=/srv/vyre-test/win11
CPUS="${VM_CPUS:-4}"
avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
# 4 GB for the install; 6 GB only while more than 3 GB would still be free. VM_MEM overrides.
if [ -n "${VM_MEM:-}" ]; then MEM="$VM_MEM"; elif [ "${1:-}" != install ] && [ "$avail" -gt $((6144 + 3072)) ]; then MEM=6144; else MEM=4096; fi
cd "$ROOT"
# The swapfile (a safety net so a memory squeeze swaps the VM rather than killing CI or the live box).
sh "$ROOT/swap.sh" on
# /dev/kvm is root:kvm and udev resets any earlier grant, so give this user access each start.
sudo setfacl -m "u:$(id -un):rw" /dev/kvm
if systemctl --user is-active --quiet vyre-win11.service; then echo "already running"; exit 0; fi
[ "$avail" -gt $((MEM + 1024)) ] || { echo "only ${avail} MB available, need $((MEM + 1024)); drop a runner or lower VM_MEM" >&2; exit 1; }

# A TPM 2.0 needs its state made once (endorsement key and certs) before swtpm will start.
[ -e "$ROOT/tpm/tpm2-00.permall" ] || swtpm_setup --tpm2 --tpmstate "$ROOT/tpm" --createek --lock-nvram --overwrite >"$ROOT/logs/swtpm-setup.log" 2>&1

CODE=$(ls /usr/share/OVMF/OVMF_CODE_4M.fd /usr/share/OVMF/OVMF_CODE.fd 2>/dev/null | head -1)
systemd-run --user --unit=vyre-win11-tpm --collect --quiet \
  swtpm socket --tpm2 --tpmstate dir="$ROOT/tpm" --ctrl type=unixio,path="$ROOT/run/swtpm.sock" --log file="$ROOT/logs/swtpm.log"
sleep 1

media=""
if [ "${1:-}" = install ]; then
  media="-drive file=$ROOT/iso/win11.iso,media=cdrom,if=none,id=win,readonly=on -device ide-cd,drive=win,bus=ide.0,bootindex=1
         -drive file=$ROOT/iso/virtio-win.iso,media=cdrom,if=none,id=vio,readonly=on -device ide-cd,drive=vio,bus=ide.1
         -drive file=$ROOT/iso/unattend.iso,media=cdrom,if=none,id=una,readonly=on -device ide-cd,drive=una,bus=ide.2"
fi

# shellcheck disable=SC2086
systemd-run --user --unit=vyre-win11 --collect --quiet -p OOMScoreAdjust=800 nice -n 10 \
  qemu-system-x86_64 -name vyre-win11 -machine q35,accel=kvm -cpu host -smp "$CPUS" -m "$MEM" \
  -drive if=pflash,format=raw,readonly=on,file="$CODE" -drive if=pflash,format=raw,file="$ROOT/OVMF_VARS.fd" \
  -chardev socket,id=chrtpm,path="$ROOT/run/swtpm.sock" -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-tis,tpmdev=tpm0 \
  -drive file="$ROOT/disk.qcow2",if=none,id=disk0,format=qcow2,cache=writeback -device virtio-blk-pci,drive=disk0,bootindex=2 \
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:3390-:3389 -device virtio-net-pci,netdev=n0 \
  -device qemu-xhci -device usb-tablet -vga std -vnc 127.0.0.1:1 \
  -monitor unix:"$ROOT/run/monitor.sock",server,nowait -rtc base=localtime \
  $media

if [ "${1:-}" = install ]; then
  # UEFI asks "Press any key to boot from CD": tap space for a while.
  for i in $(seq 1 30); do sleep 1; echo "sendkey spc" | nc -U -q1 "$ROOT/run/monitor.sock" >/dev/null 2>&1 || true; done
fi
echo "started. ssh -p 2222 vyre@127.0.0.1 (from the testbox), vnc 127.0.0.1:5901"
