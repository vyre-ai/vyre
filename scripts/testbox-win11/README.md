# Windows 11 test VM on the testbox

A real Windows 11 (Enterprise evaluation, free for 90 days, for testing) under QEMU/KVM, to check what
windows-latest CI cannot: the installer, the tray, the pairing screens, DPAPI, and a Drive `net use`.
Everything lives in `/srv/vyre-test/win11` on the testbox. Nothing touches `/srv/vyre`.

| Script | Does |
|---|---|
| `prepare.sh` | install QEMU, OVMF, swtpm; fetch the two ISOs; build the unattended-install disc; make the disk |
| `start.sh [install]` | start the VM (units `vyre-win11` and `vyre-win11-tpm`); 4 GB (6 GB only when plenty is free), 4 vCPUs, oom_score_adj 800, swapfile on |
| `stop.sh` | shut Windows down, stop the units, remove the swapfile |
| `swap.sh on\|off` | the 6 GB safety-net swapfile under `/srv/vyre-test` |
| `g.sh "<powershell>"` | run a command in the guest over ssh (password from the `0600` secrets file) |
| `shot.sh [out.png]` | screenshot of the guest screen, from your computer |
| `type.py 'text'` | type into the guest console through the QEMU monitor, for before ssh is up |

Ports on the testbox only: ssh 2222, rdp 3390, vnc 5901 (display :1). Reach them with `ssh -L`.

Things this setup needed on Ubuntu 24.04 (learned the slow way):
- swtpm runs under AppArmor: `/etc/apparmor.d/local/usr.bin.swtpm` gets `/srv/vyre-test/win11/** rwk,`.
- `/dev/kvm` is root:kvm and udev resets any grant, so `start.sh` runs `setfacl` each time.
- q35 CD-ROMs need explicit buses (`ide.0`, `ide.1`, `ide.2`).
- Windows Setup needs the LabConfig bypass keys (an emulated CPU and firmware); they are in `autounattend.xml.in`.
- The guest is starved when the CI runners are busy: host load 30 on 8 CPUs makes it unusable.
