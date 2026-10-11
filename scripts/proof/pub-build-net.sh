#!/bin/sh
# Row 37 on a real Docker host (a throwaway test box with passwordless sudo): the build network the helper makes (box/vyre sp_pub_net) with the same rules, a probe from it to the metadata address, the bridge gateway and the vyre container, a public connect, and the control: the default bridge reaches the metadata address. Removes what it made.
set -u
IMG="moby/buildkit:v0.17.3-rootless@sha256:5f1fad127999e9fedfb19edbdd8dbbd5849268b89ff3dc247322730832c25568"
docker network rm vyre-pub-build >/dev/null 2>&1
docker network create --driver bridge --opt com.docker.network.bridge.name=vyrepub0 --opt com.docker.network.bridge.enable_icc=false --label run.vyre=1 vyre-pub-build >/dev/null && echo "network made"
for c in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3; do sudo iptables -w -C DOCKER-USER -i vyrepub0 -d $c -j DROP 2>/dev/null || sudo iptables -w -I DOCKER-USER 1 -i vyrepub0 -d $c -j DROP; done
sudo iptables -w -C INPUT -i vyrepub0 -j DROP 2>/dev/null || sudo iptables -w -I INPUT 1 -i vyrepub0 -j DROP
for ns in $(sed -n 's/^nameserver[[:space:]][[:space:]]*\([0-9][0-9.]*\)[[:space:]]*$/\1/p' /etc/resolv.conf | grep -v '^127\.' | head -n 3); do for pr in udp tcp; do sudo iptables -w -C DOCKER-USER -i vyrepub0 -p $pr -d $ns --dport 53 -j ACCEPT 2>/dev/null || sudo iptables -w -I DOCKER-USER 1 -i vyrepub0 -p $pr -d $ns --dport 53 -j ACCEPT; done; done
GW=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' vyre-pub-build)
VY=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' vyre-vyre-1 2>/dev/null | tr -s ' ' '\n' | sed -n '/^[0-9][0-9.]*$/p' | head -n 3)
echo "targets: 169.254.169.254 $GW $VY"
for t in 169.254.169.254 $GW $VY; do echo -n "$t -> "; timeout 20 docker run --rm --network vyre-pub-build --cap-drop ALL --entrypoint sh $IMG -c "nc -w 2 -z $t 80 >/dev/null 2>&1 && echo OPEN || echo CLOSED"; done
echo -n "public https (github.com:443) -> "; timeout 30 docker run --rm --network vyre-pub-build --cap-drop ALL --entrypoint sh $IMG -c "nc -w 4 -z github.com 443 >/dev/null 2>&1 && echo OPEN || echo CLOSED"
echo -n "control, default bridge to metadata: "; timeout 20 docker run --rm --cap-drop ALL --entrypoint sh $IMG -c "nc -w 2 -z 169.254.169.254 80 >/dev/null 2>&1 && echo OPEN || echo CLOSED"
for c in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3; do sudo iptables -w -D DOCKER-USER -i vyrepub0 -d $c -j DROP 2>/dev/null; done; sudo iptables -w -D INPUT -i vyrepub0 -j DROP 2>/dev/null
docker network rm vyre-pub-build >/dev/null 2>&1; echo cleaned
