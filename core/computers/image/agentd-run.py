#!/usr/bin/python3 -I
# agentd-run: runs AS one agent's uid, started by the relay for a "run" ticket. It runs ONE command as that agent for as long as it lives and joins it to the connection by frames:
#   down (vyred to here): 4 = what to run (JSON, only ever the first frame, written by the relay), 0 = standard input, 2 = close standard input, 3 = signal (one byte: the number)
#   up (here to vyred):   0 = standard output, 1 = standard error, 2 = exit as JSON {"code": n, "signal": n or null}
# A frame is a type byte, a 4-byte big-endian length and the payload. Standard output and error stay separate. The uid, home, display and cookie are built from the uid this runs as; what to run is
# checked again here: an absolute program, a folder inside this agent's own home (symlinks resolved), and variable names that cannot change the loader or the shell. No shell is used. When the
# connection ends the command is killed. Nothing here reads a secret; a provider token, if any, is an ordinary variable the caller named.
import json, os, re, select, signal, struct, subprocess, sys

uid = os.geteuid()
if uid < 20000 or uid > 20063 or uid != os.getuid() or len(sys.argv) != 1:
    sys.exit(2)
USER = "ag%d" % uid
HOME = "/var/lib/vyre/agents/%s/home" % USER
MAX_FRAME = 4 * 1024 * 1024
CHUNK = 60 * 1024
FORBIDDEN = re.compile(r"^(PATH|HOME|USER|LOGNAME|SHELL|DISPLAY|XAUTHORITY|IFS|ENV|BASH_ENV|LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|PERL.*|RUBY.*)$")
SIGNALS = {signal.SIGINT, signal.SIGTERM, signal.SIGKILL, signal.SIGHUP}
rd, wr = 0, 1


def read_exact(n):
    out = b""
    while len(out) < n:
        chunk = os.read(rd, n - len(out))
        if not chunk:
            raise EOFError
        out += chunk
    return out


def send(kind, payload):
    data = struct.pack(">BI", kind, len(payload)) + payload
    while data:
        data = data[os.write(wr, data):]


def refuse(why):
    send(2, json.dumps({"code": None, "signal": None, "error": why}).encode())
    sys.exit(3)


try:
    kind, n = struct.unpack(">BI", read_exact(5))
    if kind != 4 or n > 32768:
        refuse("no command")
    spec = json.loads(read_exact(n))
except (EOFError, ValueError, struct.error):
    sys.exit(4)

argv, cwd, given = spec.get("argv"), spec.get("cwd"), spec.get("env") or {}
if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or not all(isinstance(a, str) and "\0" not in a for a in argv):
    refuse("a command is 1 to 64 text arguments")
if not re.fullmatch(r"/[A-Za-z0-9_./+-]{1,200}", argv[0]) or ".." in argv[0]:
    refuse("the command must be an absolute path")
real = os.path.realpath(cwd if isinstance(cwd, str) else HOME)
if real != HOME and not real.startswith(HOME + "/"):
    refuse("the folder must be inside the agent's home")
if not isinstance(given, dict) or len(given) > 16:
    refuse("env is a few NAME: value pairs")
env = {"HOME": HOME, "USER": USER, "LOGNAME": USER, "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "DISPLAY": ":%d" % (20 + uid - 20000), "XAUTHORITY": "/var/lib/vyre/x/ag%d/xauth" % uid}
for k, v in given.items():
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{0,40}", k) or FORBIDDEN.match(k) or not isinstance(v, str) or "\0" in v or len(v.encode()) > 1024:
        refuse("%s cannot be set" % k)
    env[k] = v

try:
    child = subprocess.Popen(argv, cwd=real, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True, start_new_session=True)
except OSError as e:
    refuse("could not start: %s" % e.strerror)

os.set_blocking(child.stdout.fileno(), False)
os.set_blocking(child.stderr.fileno(), False)
stdin_open = True
live = {child.stdout.fileno(): 0, child.stderr.fileno(): 1}
buf = b""
try:
    while live or child.poll() is None:
        ready, _, _ = select.select([rd] + list(live), [], [], 1.0)
        for fd in ready:
            if fd == rd:
                chunk = os.read(rd, 65536)
                if not chunk:
                    raise EOFError
                buf += chunk
                while len(buf) >= 5:
                    kind, n = struct.unpack(">BI", buf[:5])
                    if n > MAX_FRAME:
                        raise EOFError
                    if len(buf) < 5 + n:
                        break
                    payload, buf = buf[5:5 + n], buf[5 + n:]
                    if kind == 0 and stdin_open:
                        try:
                            child.stdin.write(payload)
                            child.stdin.flush()
                        except OSError:
                            stdin_open = False
                    elif kind == 2 and stdin_open:
                        stdin_open = False
                        try:
                            child.stdin.close()
                        except OSError:
                            pass
                    elif kind == 3 and len(payload) == 1 and payload[0] in SIGNALS:
                        try:
                            os.killpg(child.pid, payload[0])
                        except OSError:
                            pass
            else:
                data = os.read(fd, CHUNK)
                if data:
                    send(live[fd], data)
                else:
                    del live[fd]
        if not live and child.poll() is None:
            child.wait()
    code = child.wait()
    send(2, json.dumps({"code": code if code >= 0 else None, "signal": -code if code < 0 else None}).encode())
except (EOFError, OSError):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except OSError:
        pass
    child.wait()
