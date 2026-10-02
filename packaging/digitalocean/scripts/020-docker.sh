#!/bin/bash
# Docker from Docker's own apt repository (so security updates keep arriving through apt), with the compose plugin
# the Vyre installer needs (Docker Compose 2.24 or newer). The Vyre image itself is NOT baked in: the first boot
# installs the latest signed release.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" >/etc/apt/sources.list.d/docker.list
apt-get -y update
apt-get -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable docker
docker compose version
