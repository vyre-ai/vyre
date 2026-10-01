#!/usr/bin/env python3
"""Push `text` into a terminal as if typed (TIOCSTI), from a process that is not the terminal's own.
usage: tiocsti.py /dev/ttyNN 'text\n'   prints OK, or the OS's refusal (errno name)."""
import fcntl, os, sys, termios, errno
try:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_NOCTTY)
    for ch in sys.argv[2].encode().decode("unicode_escape"):
        fcntl.ioctl(fd, termios.TIOCSTI, ch.encode())
    print("OK")
except OSError as e:
    print("REFUSED " + errno.errorcode.get(e.errno, str(e.errno)))
except Exception as e:
    print("ERROR " + str(e)[:80])
