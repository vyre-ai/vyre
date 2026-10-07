#!/bin/bash
# The base of the image: current Ubuntu security updates, a firewall that is ON (DigitalOcean rejects an image
# whose ufw is off), and unattended security updates so a droplet keeps patching itself (the Marketplace terms
# require prompt security patches). Vyre listens only on 127.0.0.1 and reaches out through its own network and the relay (outbound), so SSH is the
# only port that needs to be open.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -y update
apt-get -o Dpkg::Options::="--force-confold" -y upgrade
apt-get -y install --no-install-recommends curl ca-certificates openssl ufw unattended-upgrades gnupg
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw --force enable
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
# Key-only SSH for root, which is what a DigitalOcean droplet gives you; no password logins at all.
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
