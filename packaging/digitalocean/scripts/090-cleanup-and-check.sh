#!/bin/bash
# DigitalOcean's own cleanup.sh and img_check.sh from marketplace-partners, at a pinned commit and checked by sha256
# before they run. A failed check stops the build, so a snapshot that DigitalOcean would reject is never made.
set -euo pipefail
C=b70878804ca27c01d5f5e882d26485defbaba210
CLEAN_SHA=5e2fe7ce30892a26ed2731238d9f26c40ae8b1084b070ce095f3b99ab1a2cc81
CHECK_SHA=91ff2b1880439c97ccdc49554c5ed8901b89ef250c8ac5fffe52811c68abac49
get() { curl -fsSL "https://raw.githubusercontent.com/digitalocean/marketplace-partners/$C/scripts/$1" -o "/tmp/$1"; echo "$2  /tmp/$1" | sha256sum -c -; }
get 90-cleanup.sh "$CLEAN_SHA"
get 99-img-check.sh "$CHECK_SHA"
bash /tmp/90-cleanup.sh || true   # its last step fills the disk with zeros and ends with a dd error by design
bash /tmp/99-img-check.sh
