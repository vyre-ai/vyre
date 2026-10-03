#!/bin/bash
# SeaweedFS spike: one master, three volume servers (own rack each), one filer with the S3 gateway; default replication 010 (two copies, two racks).
set -u
D=$HOME/spike/sw; mkdir -p $D; cd $D
docker rm -f sm sv1 sv2 sv3 sf >/dev/null 2>&1; docker network create spike-s >/dev/null 2>&1; rm -rf $D/v* $D/f
IMG=chrislusf/seaweedfs:latest
docker run -d --name sm --network spike-s --memory 512m $IMG master -ip=sm -defaultReplication=010 -volumeSizeLimitMB=128 >/dev/null
for n in 1 2 3; do mkdir -p $D/v$n
  docker run -d --name sv$n --network spike-s --memory 512m -v $D/v$n:/data $IMG volume -mserver=sm:9333 -ip=sv$n -port=8080 -dir=/data -max=30 -dataCenter=dc1 -rack=r$n >/dev/null; done
cat > $D/s3.json <<JSON
{"identities":[{"name":"spike","credentials":[{"accessKey":"spikekey","secretKey":"spikesecret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
mkdir -p $D/f
docker run -d --name sf --network spike-s --memory 768m -p 127.0.0.1:8333:8333 -v $D/s3.json:/etc/s3.json -v $D/f:/data $IMG filer -master=sm:9333 -s3 -s3.config=/etc/s3.json -defaultReplicaPlacement=010 -dir=/data >/dev/null
sleep 8
docker exec sf sh -c 'echo "s3.bucket.create -name pool" | weed shell -master=sm:9333' 2>&1 | tail -2
