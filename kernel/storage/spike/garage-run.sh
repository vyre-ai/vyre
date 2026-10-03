#!/bin/bash
# Garage measurements: idle memory, write, per-node disk (replication), read, node drop (stop g3), write while down, read while down, heal after return,
# then permanent loss of g3 (layout remove) and time to re-replicate onto the two that remain.
set -u
cd ~/spike
KEY=$(docker exec g1 /garage key info spike --show-secret 2>/dev/null | awk '/Key ID/{print $3}'); SEC=$(docker exec g1 /garage key info spike --show-secret 2>/dev/null | awk '/Secret/{print $3}')
L="$HOME/spike-venv/bin/python load.py http://127.0.0.1:3900 $KEY $SEC pool"
mem() { docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' g1 g2 g3 | tr '\n' ' '; echo; }
du_() { for n in 1 2 3; do printf "g$n=%sM " $(du -sm $HOME/spike/garage/n$n/data | cut -f1); done; echo; }
for n in 1 2 3; do docker exec g$n /garage worker set resync-worker-count 4 >/dev/null 2>&1; docker exec g$n /garage worker set resync-tranquility 0 >/dev/null 2>&1; done
echo "== idle memory"; mem
echo "== write 150 x 4 MiB"; $L put 150 4; mem; echo -n "disk per node: "; du_
echo "== read all 150"; $L get 150 4
echo "== stop g3 (a node drops out)"; docker stop g3 >/dev/null; sleep 3
echo "-- read while down"; $L get 150 4
echo "-- write while down (new 40)"; START=150 $L put 40 4
echo "== g3 returns"; docker start g3 >/dev/null; sleep 15
echo "-- read all 190"; $L get 190 4; echo -n "disk per node: "; du_
for i in 1 2 3 4 5 6; do echo -n "resync queue t+$((i*10))s: "; docker exec g1 /garage stats 2>/dev/null | grep -iE 'resync|queue' | tr '\n' ' '; echo; sleep 10; done
echo -n "disk per node after catch-up: "; du_
echo "== g3 lost for good: remove from layout"
docker stop g3 >/dev/null; sleep 3
ID3=$(docker exec g1 /garage status 2>/dev/null | awk '/z3/{print $1}')
docker exec g1 /garage layout remove "$ID3" >/dev/null; docker exec g1 /garage layout apply --version 2 | tail -1
T0=$(date +%s)
for i in $(seq 1 24); do sleep 10; printf "t+%ss " $(( $(date +%s)-T0 )); du_; done
echo "-- read all 190 after re-layout"; $L get 190 4
mem
