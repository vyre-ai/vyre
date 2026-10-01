#!/bin/sh
# Screenshot of the VM screen, saved as a PNG on this computer: sh shot.sh [out.png]
# (screendump through the QEMU monitor on the testbox, copied back, converted with plain Python.)
set -eu
out="${1:-/tmp/win11.png}"
ssh testbox 'echo "screendump /srv/vyre-test/win11/run/s.ppm" | nc -U -q1 /srv/vyre-test/win11/run/monitor.sock >/dev/null; sleep 1'
scp -q testbox:/srv/vyre-test/win11/run/s.ppm /tmp/win11.ppm
python3 - "$out" <<'PY'
import sys, zlib, struct
d = open('/tmp/win11.ppm', 'rb').read()
parts = d.split(b'\n', 3)
w, h = map(int, parts[1].split()); px = parts[3]
raw = b''.join(b'\x00' + px[y*w*3:(y+1)*w*3] for y in range(h))
def ch(t, b): c = struct.pack('>I', len(b)) + t + b; return c + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
open(sys.argv[1], 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))
PY
echo "$out"
