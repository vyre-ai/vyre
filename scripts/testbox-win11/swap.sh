#!/bin/sh
# The VM's safety-net swapfile, under /srv/vyre-test only. `swap.sh on` makes and enables a 6 GB
# file; `swap.sh off` disables and removes it (stop.sh calls this, so nothing is left behind).
set -eu
F=/srv/vyre-test/win11/swapfile
case "${1:-}" in
  on)
    swapon --show=NAME --noheadings | grep -qx "$F" && exit 0
    [ -f "$F" ] || { sudo fallocate -l 6G "$F" && sudo chmod 600 "$F" && sudo mkswap -q "$F"; }
    sudo swapon "$F"
    ;;
  off)
    if swapon --show=NAME --noheadings | grep -qx "$F"; then sudo swapoff "$F"; fi
    sudo rm -f "$F"
    ;;
  *) echo "usage: swap.sh on|off" >&2; exit 1 ;;
esac
