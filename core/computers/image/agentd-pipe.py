#!/usr/bin/python3 -I
# agentd-pipe KIND: runs AS one agent's uid and joins standard input and output to one of that agent's own sockets: KIND vnc is its screen, KIND cdp is its Chrome's debugging pipe (agentd-chrome.py).
# KIND is one of those two words and nothing else; there is no path argument and no environment to steer it: the socket path is built from the uid it runs as, and a uid that is not one of the agent users is refused.
import os, select, socket, sys

uid = os.geteuid()
SOCKETS = {"vnc": "vnc.sock", "cdp": "cdp.sock"}
if uid < 20000 or uid > 20063 or uid != os.getuid() or len(sys.argv) != 2 or sys.argv[1] not in SOCKETS:
    sys.exit(2)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/var/lib/vyre/agents/ag%d/%s" % (uid, SOCKETS[sys.argv[1]]))
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
