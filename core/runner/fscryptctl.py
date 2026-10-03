#!/usr/bin/env python3
# A tiny, standard-library-only wrapper over the kernel's fscrypt ioctls (Linux 5.4+, no root needed once the filesystem has the
# "encrypt" feature turned on, which is the one-time admin step). The key is read from stdin (64 raw bytes as hex), never an argument.
#   fscryptctl.py probe  <dir>            exit 0 if this directory's filesystem can encrypt, else 3 and the reason on stderr
#   fscryptctl.py add    <dir>            read the key, add it to the filesystem, print the key identifier (hex)
#   fscryptctl.py policy <dir>            read the key, add it, and set the policy on the EMPTY directory (creates the workspace)
#   fscryptctl.py status <dir>            print present | absent | incomplete for the key that protects <dir>
#   fscryptctl.py remove <dir>            remove the directory's key from the filesystem (locks it; needs no key), print removed | incomplete
import fcntl, os, struct, sys, ctypes

def _ioc(d, t, nr, size): return (d << 30) | (size << 16) | (ord(t) << 8) | nr
IOWR, IOR = 3, 2
ADD = _ioc(IOWR, 'f', 23, 80)
REMOVE = _ioc(IOWR, 'f', 24, 64)
SET_POLICY = _ioc(IOR, 'f', 19, 12)
KEY_STATUS = _ioc(IOWR, 'f', 26, 128)
GET_POLICY_EX = _ioc(IOWR, 'f', 22, 9)
IDENT = 2

def read_key():
    h = sys.stdin.buffer.read().strip()
    raw = bytes.fromhex(h.decode())
    if len(raw) != 64: raise SystemExit("the key must be 64 bytes")
    return raw

def add_key(fd, raw):
    buf = ctypes.create_string_buffer(80 + len(raw))
    struct.pack_into("<II32x", buf, 0, IDENT, 0)          # key_spec: type, reserved, union
    struct.pack_into("<I", buf, 40, len(raw))              # raw_size
    buf[80:80 + len(raw)] = raw
    fcntl.ioctl(fd, ADD, buf, True)
    return bytes(buf[8:24])                                # identifier is written back into key_spec.u

def open_dir(p): return os.open(p, os.O_RDONLY | os.O_DIRECTORY)

def spec_buf(ident, size):
    b = ctypes.create_string_buffer(size)
    struct.pack_into("<II", b, 0, IDENT, 0); b[8:24] = ident
    return b

def main():
    cmd, path = sys.argv[1], sys.argv[2]
    try:
        if cmd == "probe":
            fd = open_dir(path)
            try:
                raw = os.urandom(64); ident = add_key(fd, raw)
                b = spec_buf(ident, 64)
                try: fcntl.ioctl(fd, REMOVE, b, True)
                except OSError: pass
            finally: os.close(fd)
            return 0
        if cmd == "remove":
            # Lock: the key's identifier is read from the directory's own policy, so no key is needed (the lease key is gone by now).
            fd = open_dir(path)
            try:
                buf = ctypes.create_string_buffer(8 + 24)
                struct.pack_into("<Q", buf, 0, 24)
                fcntl.ioctl(fd, GET_POLICY_EX, buf, True)
                b = spec_buf(bytes(buf[16:32]), 64)
                fcntl.ioctl(fd, REMOVE, b, True)
                flags = struct.unpack_from("<I", b, 40)[0]
                print("incomplete" if flags & 1 else "removed"); return 0
            finally: os.close(fd)
        if cmd in ("add", "policy"):
            raw = read_key(); fd = open_dir(path)
            try:
                if cmd == "add":
                    print(add_key(fd, raw).hex()); return 0
                if cmd == "policy":
                    ident = add_key(fd, raw)
                    pol = struct.pack("<BBBB4x16s", 2, 1, 4, 0, ident)   # v2, AES-256-XTS contents, AES-256-CTS filenames
                    fcntl.ioctl(fd, SET_POLICY, pol); print(ident.hex()); return 0
            finally: os.close(fd)
        if cmd == "status":
            fd = open_dir(path)
            try:
                # find the policy identifier of the directory (the workspace sets it on itself)
                buf = ctypes.create_string_buffer(8 + 24)
                struct.pack_into("<Q", buf, 0, 24)         # policy_size in, filled in out
                fcntl.ioctl(fd, GET_POLICY_EX, buf, True)
                ident = bytes(buf[16:32])                  # v2 policy at offset 8: 8 bytes of fields, then the 16-byte identifier
                b = spec_buf(ident, 128)
                fcntl.ioctl(fd, KEY_STATUS, b, True)
                st = struct.unpack_from("<I", b, 64)[0]
                print({1: "absent", 2: "present", 3: "incomplete"}.get(st, "absent")); return 0
            finally: os.close(fd)
    except OSError as e:
        sys.stderr.write("%s: %s\n" % (cmd, os.strerror(e.errno))); return 3
    return 2

sys.exit(main())
