import os, sys
# double fork; keep the session (and so the controlling tty), only setpgid so the process leads its own group
if os.fork(): os._exit(0)
if os.fork(): os._exit(0)
os.setpgid(0, 0)
import time; time.sleep(1)   # let the parents exit so ppid is 1
os.execvp("node", ["node", sys.argv[1], sys.argv[2], sys.argv[3]])
