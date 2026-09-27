#!/usr/bin/env python3
# Keep the top H rows of a PNG, in place. sips crops around the centre, so it cannot do this.
# PNG row filters only look at the row above, so the top rows decode unchanged.
import struct, sys, zlib
src, h = sys.argv[1], int(sys.argv[2])
d = open(src, 'rb').read()
i, idat = 8, b''
while i < len(d):
    n, = struct.unpack('>I', d[i:i + 4]); t = d[i + 4:i + 8]; body = d[i + 8:i + 8 + n]; i += 12 + n
    if t == b'IHDR': ihdr = body
    elif t == b'IDAT': idat += body
w, H, bd, ct = struct.unpack('>IIBB', ihdr[:10])
if H > h:
    stride = w * {2: 3, 6: 4}[ct] * (bd // 8) + 1
    raw = zlib.decompress(idat)[:stride * h]
    ch = lambda t, b: struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    open(src, 'wb').write(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, bd, ct, 0, 0, 0))
                          + ch(b'IDAT', zlib.compress(raw, 6)) + ch(b'IEND', b''))
