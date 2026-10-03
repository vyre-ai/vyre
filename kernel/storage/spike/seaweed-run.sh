#!/bin/bash
set -u
cd ~/spike
L="env REGION=us-east-1 $HOME/spike-venv/bin/python load.py http://127.0.0.1:8333 spikekey spikesecret pool"
mem() { docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' sm sv1 sv2 sv3 sf | tr '\n' ' '; echo; }
du_() { for n in 1 2 3; do printf "sv$n=%sM " $(du -sm $HOME/spike/sw/v$n | cut -f1); done; echo; }
echo "== idle memory"; mem
echo "== write 150 x 4 MiB"; $L put 150 4; mem; echo -n "disk per node: "; du_
echo "== read all 150"; $L get 150 4
echo "== stop sv3 (a node drops out)"; docker stop sv3 >/dev/null; sleep 5
echo "-- read while down"; $L get 150 4
echo "-- write while down (new 40)"; START=150 $L put 40 4
echo "== sv3 returns"; docker start sv3 >/dev/null; sleep 20
echo "-- read all 190"; $L get 190 4; echo -n "disk per node: "; du_
echo "== check replication state (shell volume.fix.replication, dry)"
docker exec sf sh -c 'printf "lock\nvolume.fix.replication -n\nunlock\n" | weed shell -master=sm:9333' 2>&1 | tail -6
echo "== sv3 lost for good"
docker stop sv3 >/dev/null; sleep 5
T0=$(date +%s)
docker exec sf sh -c 'printf "lock\nvolume.fix.replication\nunlock\n" | weed shell -master=sm:9333' 2>&1 | tail -4
echo "fix.replication took $(( $(date +%s)-T0 ))s"; echo -n "disk per node: "; du_
echo "-- read all 190 after fix"; $L get 190 4
mem
