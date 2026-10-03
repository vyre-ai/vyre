#!/bin/bash
# kernel-pair.sh: a properly paired pair of real machines for the remote kernel call (see kernel-pair.mjs for what it builds).
#   kernel-pair.sh up                       bring both Spaces up and pair them with the real Wink flow (testbox only)
#   kernel-pair.sh status
#   kernel-pair.sh call A|B home|device grants.members.list [alice|bob] [JSON args...] [--proof setRole]
#   kernel-pair.sh as A|B alice|bob         whom the home maps the device to
#   kernel-pair.sh selftest [A|B]           members.list, join card and accept, role change, replay and no-proof refusals, with timings
#   kernel-pair.sh bench [A|B]              50 members.list calls: min, p50, p95, path
#   kernel-pair.sh reconnect [A|B]          a fresh link (direct first, relay after 3 s); run after block-udp and unblock-udp
#   kernel-pair.sh block-udp | unblock-udp  drop UDP for the second box's test user only (iptables owner rule); calls then use the relay peer stream
#   kernel-pair.sh down [--purge]           stop only what `up` started (pids in ~/wink-kernel/run-*/pids), remove its ufw and iptables rules
# Needs ssh to `testbox` (box1) and `testbox2` (box2) (override with KP_BOX1_SSH / KP_BOX2_SSH; the addresses come from the ssh config), sudo there, and linux binaries wink-forwarder and
# headscale in $KP_BIN_DIR (default /tmp/kp-bin; build: `cd wink/forwarder && go build -o wink-forwarder .`). KP_TREE = the checkout to ship (default this one);
# KP_KERNEL_REF (default origin/work/kernel-spaces, empty to skip) overlays kernel/remote from that ref so kernel-2's latest is what runs.
set -e
exec node "$(cd "$(dirname "$0")" && pwd)/kernel-pair.mjs" "$@"
