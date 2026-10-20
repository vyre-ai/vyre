#!/usr/bin/python3 -I
# agentd-chrome: runs AS an agent's BROWSER uid (agb21000..agb21063), never the agent's own. Starts that agent's Chrome with its debugging PIPE (no TCP debug port exists for any agent) and exposes
# the pipe on a unix socket in the browser uid's own 0700 folder, so the agent's shell can reach neither the socket, the profile nor the browser's memory. No argument and no environment steer it: the
# socket, the profile, the downloads folder, the display and Chrome's flags are fixed here and built from the uid, and nothing a client sends reaches Chrome's command line. One client at a time: a second
# connection is refused, never allowed to replace the first. CDP messages are NUL-terminated JSON; one message is capped, so is what waits to be written to a slow client, and a client that says nothing for
# ten minutes is dropped. When Chrome ends, this ends, and so does the socket. The password manager, autofill and sync are off in the profile (and by Chrome's managed policy); downloads go to a folder
# the agent can read and the browser cannot open anything from.
import json, os, select, signal, socket, subprocess, sys, time

uid = os.geteuid()
if uid < 21000 or uid > 21063 or uid != os.getuid() or len(sys.argv) != 1:
    sys.exit(2)
N = uid - 1000                      # the agent's own uid
BASE = "/var/lib/vyre/browsers/agb%d" % uid
PROFILE = BASE + "/profile"
SOCK = BASE + "/cdp.sock"
DOWNLOADS = "/var/lib/vyre/downloads/ag%d" % N
# The dock's Chrome button (agentd-dock.py, the agent's uid): a FIFO in the folder that already carries the agent's X cookie (the browser's, group = the agent's, 2750, so the agent cannot
# replace it). The agent may write to it and nothing it writes is read: any byte means "show Chrome", at most once every two seconds, and the holder then opens one blank tab itself.
SHOW = "/var/lib/vyre/x/ag%d/show-chrome" % N
SHOW_ID = 2147000001                # far above any id a client of the pipe counts up to; its answer is dropped by the client (no such pending call)
MAX_MSG = 16 * 1024 * 1024
MAX_PENDING = 32 * 1024 * 1024
IDLE = 600
ENV = {"HOME": BASE, "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "DISPLAY": ":%d" % (20 + N - 20000), "XAUTHORITY": BASE + "/xauth"}

# What the profile says before Chrome reads it: no password store, no autofill, no sign-in or sync, and where downloads go (a fixed folder, no prompt).
PREFS = {
    "credentials_enable_service": False, "credentials_enable_autosignin": False,
    "profile": {"password_manager_enabled": False, "password_manager_leak_detection": False},
    "autofill": {"profile_enabled": False, "credit_card_enabled": False},
    "signin": {"allowed": False}, "sync": {"requested": False},
    "download": {"default_directory": DOWNLOADS, "prompt_for_download": False, "directory_upgrade": True, "extensions_to_open": ""},
    "plugins": {"always_open_pdf_externally": False},
    "savefile": {"default_directory": DOWNLOADS},
}


def merge(into, extra):
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(into.get(k), dict):
            merge(into[k], v)
        else:
            into[k] = v


os.makedirs(PROFILE + "/Default", mode=0o700, exist_ok=True)
prefs_file = PROFILE + "/Default/Preferences"
try:
    with open(prefs_file) as f:
        prefs = json.load(f)
except (OSError, ValueError):
    prefs = {}
merge(prefs, PREFS)
with open(prefs_file, "w") as f:
    json.dump(prefs, f)
os.chmod(prefs_file, 0o600)

os.umask(0o027)   # a download is readable by the agent (the folder's group), never writable by it

to_chrome_r, to_chrome_w = os.pipe()
from_chrome_r, from_chrome_w = os.pipe()


def into_place():
    os.dup2(to_chrome_r, 3)
    os.dup2(from_chrome_w, 4)


chrome = subprocess.Popen(
    ["/usr/bin/chromium", "--user-data-dir=" + PROFILE, "--no-first-run", "--restore-last-session", "--disk-cache-dir=" + BASE + "/cache",
     "--password-store=basic", "--disable-sync", "--disable-extensions", "--no-default-browser-check", "--remote-debugging-pipe",
     # closing the last window leaves Chrome running (the holder, the agent's hands and the dock's Chrome button keep working); sleep still ends it with Browser.close
     "--keep-alive-for-test",
     # the computer is the sandbox: Docker's default seccomp refuses the namespaces Chrome's own sandbox needs ("No usable sandbox!"), exactly as for the computer's Chrome in entrypoint.sh
     "--no-sandbox", "--test-type", "--disable-gpu"],
    env=ENV, preexec_fn=into_place, pass_fds=(3, 4), close_fds=True)
os.close(to_chrome_r)
os.close(from_chrome_w)

try:
    os.unlink(SOCK)
except OSError:
    pass
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
old = os.umask(0o177)
srv.bind(SOCK)
os.umask(old)
os.chmod(SOCK, 0o600)
srv.listen(1)


def show_fifo():
    # made fresh each start, as the browser uid, in the setgid folder: the group is the agent's, and only the group may write (no read: the agent learns nothing from it)
    try:
        os.unlink(SHOW)
    except OSError:
        pass
    try:
        os.mkfifo(SHOW, 0o600)
        os.chmod(SHOW, 0o620)
        # read and write, so the FIFO never reads as closed when a writer goes away
        return os.open(SHOW, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return None     # no button, nothing else lost


show = show_fifo()
show_due = False   # a show was asked for and waits for the client's message in progress to end
show_at = 0.0

client = None
out = b""          # waiting to be written to the client
since_nul = 0      # bytes of the client's current message so far
last = time.time()


def drop():
    global client, out, since_nul
    if client is not None:
        try:
            client.close()
        except OSError:
            pass
    client, out, since_nul = None, b"", 0


def finish(*_):
    # Ask Chrome to close itself first, over the pipe this holder owns: a clean close writes the profile (cookies are committed on a timer, so a login made seconds ago is lost to a plain SIGTERM).
    # Give it a few seconds, then end it.
    try:
        if chrome.poll() is None:
            os.write(to_chrome_w, b'{"id":1,"method":"Browser.close"}\0')
            chrome.wait(timeout=8)
    except Exception:
        pass
    try:
        if chrome.poll() is None:
            chrome.terminate()
    except OSError:
        pass
    for path in (SOCK, SHOW):
        try:
            os.unlink(path)
        except OSError:
            pass
    sys.exit(0)


signal.signal(signal.SIGTERM, finish)
while chrome.poll() is None:
    rl = [srv, from_chrome_r] + ([client] if client else []) + ([show] if show is not None else [])
    wl = [client] if client and out else []
    ready, writable, _ = select.select(rl, wl, [], 5)
    if client and time.time() - last > IDLE:
        drop()
    if show is not None and show in ready:
        try:
            os.read(show, 4096)     # what was written is never looked at
        except OSError:
            pass
        if time.time() - show_at >= 2:
            show_due, show_at = True, time.time()
    # only between two of the client's messages, so the tab request is never written into the middle of one
    if show_due and since_nul == 0:
        show_due = False
        os.write(to_chrome_w, b'{"id":%d,"method":"Target.createTarget","params":{"url":"about:blank"}}\0' % SHOW_ID)
    if srv in ready:
        c, _ = srv.accept()
        if client is None:
            client = c
            client.setblocking(False)
            last = time.time()
        else:
            c.close()
    if from_chrome_r in ready:
        data = os.read(from_chrome_r, 65536)
        if not data:
            break
        if client is not None:
            out += data
            if len(out) > MAX_PENDING:
                drop()
    if client is not None and client in writable:
        try:
            sent = client.send(out[:65536])
            out = out[sent:]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            drop()
    if client is not None and client in ready:
        try:
            data = client.recv(65536)
        except (BlockingIOError, InterruptedError):
            data = None
        except OSError:
            data = b""
        if data == b"":
            drop()
        elif data:
            last = time.time()
            # the length of the message in progress; one over the cap ends the client
            pieces = data.split(b"\0")
            if since_nul + len(pieces[0]) > MAX_MSG or any(len(p) > MAX_MSG for p in pieces):
                drop()
                continue
            since_nul = since_nul + len(pieces[0]) if len(pieces) == 1 else len(pieces[-1])
            while data:
                data = data[os.write(to_chrome_w, data):]
finish()
