#!/usr/bin/python3 -I
# agentd-term SESSION: runs AS one agent's uid and joins standard input and output to a terminal in that agent's own tmux (made if it is not there yet). The tmux socket is
# built from the uid it runs as, the session name is checked, and a uid that is not one of the agent users is refused.
import fcntl, os, pty, re, select, signal, struct, sys, termios

uid = os.geteuid()
if uid < 20000 or uid > 20063 or uid != os.getuid() or len(sys.argv) != 2 or not re.fullmatch(r"[A-Za-z0-9_.-]{1,40}", sys.argv[1]):
    sys.exit(2)
sock = "/var/lib/vyre/agents/ag%d/tmux.sock" % uid
pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv("/usr/bin/tmux", ["tmux", "-S", sock, "new-session", "-A", "-s", sys.argv[1]])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 120, 0, 0))
try:
    while True:
        ready, _, _ = select.select([0, fd], [], [])
        if fd in ready:
            data = os.read(fd, 65536)
            if not data:
                break
            while data:
                data = data[os.write(1, data):]
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                break
            os.write(fd, data)
except OSError:
    pass
try:
    os.kill(pid, signal.SIGHUP)
except OSError:
    pass
