#!/bin/bash
# Garage spike: 3 nodes in docker on one host, replication factor 2 (RF=${RF:-2}), 512 MB memory limit each.
set -u
D=$HOME/spike/garage; mkdir -p $D; cd $D
RF=${RF:-2}; SECRET=$(printf '%064d' 7 | head -c 64)
docker rm -f g1 g2 g3 >/dev/null 2>&1; docker network create spike-g >/dev/null 2>&1; rm -rf $D/n*
for n in 1 2 3; do
  mkdir -p $D/n$n/meta $D/n$n/data
  cat > $D/n$n/garage.toml <<TOML
metadata_dir = "/data/meta"
data_dir = "/data/data"
db_engine = "lmdb"
replication_factor = $RF
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "g$n:3901"
rpc_secret = "$SECRET"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
[admin]
api_bind_addr = "[::]:3903"
admin_token = "spike-admin"
TOML
  docker run -d --name g$n --network spike-g --memory 512m -v $D/n$n:/data -v $D/n$n/garage.toml:/etc/garage.toml $( [ $n = 1 ] && echo "-p 127.0.0.1:3900:3900" ) dxflrs/garage:v2.4.1 >/dev/null
done
sleep 4
G="docker exec g1 /garage"
ids=(); for n in 1 2 3; do ids+=($(docker exec g$n /garage node id -q 2>/dev/null | head -1)); done
for n in 2 3; do $G node connect "${ids[$((n-1))]}" >/dev/null 2>&1; done
sleep 2
for n in 1 2 3; do $G layout assign -z z$n -c 20G "$(echo ${ids[$((n-1))]} | cut -d@ -f1)" >/dev/null; done
$G layout apply --version 1 | tail -2
$G bucket create pool >/dev/null; $G key create spike >/dev/null
$G bucket allow --read --write --owner pool --key spike >/dev/null
$G key info spike --show-secret | grep -E 'Key ID|Secret' 
