#!/usr/bin/python3 -I
# agentd-pipe KIND: runs AS one agent's uid and joins standard input and output to one of that agent's own sockets: KIND vnc is its screen, KIND cdp is its Chrome's debugging pipe (agentd-chrome.py).
# KIND is one of those two words and nothing else; there is no path argument and no environment to steer it: the socket path is built from the uid it runs as, and a uid that is not one of the agent users is refused.
import os, select, socket, sys

uid = os.geteuid()
# vnc runs as the agent (ag20000..ag20063) and opens that agent's screen; cdp runs as the agent's BROWSER uid (21000..21063) and opens its Chrome's debugging socket. Each kind has its own uid range and path.
KINDS = {"vnc": (20000, "/var/lib/vyre/agents/ag%d/vnc.sock"), "cdp": (21000, "/var/lib/vyre/browsers/agb%d/cdp.sock")}
if len(sys.argv) != 2 or sys.argv[1] not in KINDS or uid != os.getuid():
    sys.exit(2)
base, pattern = KINDS[sys.argv[1]]
if uid < base or uid > base + 63:
    sys.exit(2)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(pattern % uid)
src, out, open_in = 0, 1, True
while True:
    ready, _, _ = select.select([src, s] if open_in else [s], [], [])
    if s in ready:
        data = s.recv(65536)
        if not data:
            break
        while data:
            data = data[os.write(out, data):]
    if open_in and src in ready:
        data = os.read(src, 65536)
        if not data:
            break
        s.sendall(data)
