#!/bin/bash
# SeaweedFS erasure coding spike: N volume servers (default 4, one rack each), replication 000 (one copy) because EC supplies the redundancy, write chunks,
# fill volumes, ec.encode them, check shard spread, stop one node, read everything back, then stop a second.
set -u
N=${N:-4}; D=$HOME/spike/swec; mkdir -p $D; cd $D
docker rm -f em $(seq -f 'ev%g' 1 $N) ef >/dev/null 2>&1; docker network create spike-e >/dev/null 2>&1; docker run --rm -v $D:/d alpine sh -c 'rm -rf /d/v* /d/f'
IMG=chrislusf/seaweedfs:latest
docker run -d --name em --network spike-e --memory 512m $IMG master -ip=em -defaultReplication=000 -volumeSizeLimitMB=64 >/dev/null
for n in $(seq 1 $N); do mkdir -p $D/v$n; docker run -d --name ev$n --network spike-e --memory 512m -v $D/v$n:/data $IMG volume -mserver=em:9333 -ip=ev$n -port=8080 -dir=/data -max=200 -dataCenter=dc1 -rack=r$n >/dev/null; done
cat > $D/s3.json <<JSON
{"identities":[{"name":"spike","credentials":[{"accessKey":"spikekey","secretKey":"spikesecret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
mkdir -p $D/f
docker run -d --name ef --network spike-e --memory 768m -p 127.0.0.1:8334:8333 -v $D/s3.json:/etc/s3.json -v $D/f:/data $IMG filer -master=em:9333 -s3 -s3.config=/etc/s3.json -defaultReplicaPlacement=000 -defaultStoreDir=/data >/dev/null
sleep 8
docker exec ef sh -c 'echo "s3.bucket.create -name pool" | weed shell -master=em:9333' 2>&1 | tail -1
L="env REGION=us-east-1 $HOME/spike-venv/bin/python $HOME/spike/load.py http://127.0.0.1:8334 spikekey spikesecret pool"
du_() { for n in $(seq 1 $N); do printf "ev$n=%sM " $(du -sm $D/v$n | cut -f1); done; echo; }
echo "== write 120 x 4 MiB"; $L put 120 4; du_
sh() { docker exec ef sh -c "printf '$1\n' | weed shell -master=em:9333" 2>&1; }
echo "== volumes"; sh 'volume.list' | grep -E "volume id|Disk" | head -20
echo "== ec.encode (all volumes of the bucket collection, force)"
sh 'lock\nec.encode -collection pool -fullPercent=0 -quietFor=0s\nunlock' | tail -8
sleep 5; du_
echo "-- read all after encode"; $L get 120 4
echo "== shard spread"; sh 'volume.list' | grep -i "ec volume" | head -12
echo "== stop ev1"; docker stop ev1 >/dev/null; sleep 6; $L get 120 4
echo "== stop ev2 as well"; docker stop ev2 >/dev/null; sleep 6; $L get 120 4
docker start ev1 ev2 >/dev/null; sleep 8; echo "== both back"; $L get 120 4
