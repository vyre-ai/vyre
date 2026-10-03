#!/bin/bash
# reset.sh: stop what this spike started (by pidfile only), wipe state, start hs A B C (loopback) and mint keys.
W=${W:-$HOME/spike-wink2}; cd $W
for f in hs-*/pid st/*.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null; done; sleep 1
rm -rf hs-* st keys; mkdir -p st keys logs
for x in A:28081:23478 B:28082:23479 C:28083:23480; do IFS=: read sp port stun <<<"$x"; ./src/hs-up.sh $sp 127.0.0.1 $port $stun; done
cat hs-*/cert.pem > ca-bundle.pem
for sp in A B C; do ./src/hs-key.sh $sp tag:hub > keys/hub-$sp; ./src/hs-key.sh $sp tag:device > keys/dev-$sp; done
