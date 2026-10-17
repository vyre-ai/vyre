#!/usr/bin/python3 -I
# agentd-pipe: runs AS one agent's uid and joins standard input and output to that agent's own screen socket. There is no argument and no
# environment to steer it: the socket path is built from the uid it runs as, and a uid that is not one of the agent users is refused.
import os, select, socket, sys

uid = os.geteuid()
if uid < 20000 or uid > 20063 or uid != os.getuid():
    sys.exit(2)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/var/lib/vyre/agents/ag%d/vnc.sock" % uid)
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
