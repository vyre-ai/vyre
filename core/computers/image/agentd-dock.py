#!/usr/bin/python3 -I
# agentd-dock: the dock at the bottom of an agent's screen, with three apps and nothing else: Chrome, Terminal and Files (owner, 20 Oct 2026: "like a Mac's, really beautiful"). It runs AS the agent's own uid
# (ag20000..ag20063) with the agent's UNTRUSTED X cookie, like any window the agent opens: it can draw its own window and cannot read, grab or type into anyone else's.
#   Terminal  opens a terminal in the agent's folder, on the agent's own tmux (session "desk"), so what runs there keeps running when the screen sleeps and is one of the
#             agent's terminals in Vyre too (agentd-term.py uses the same socket).
#   Files     opens the file manager on the agent's folder. It runs as the agent, so it reaches exactly what the agent's uid may: its own folder, and Downloads (read only).
#   Chrome    Chrome is the browser uid's, which the agent cannot start or reach. The button writes one byte to the holder's FIFO (agentd-chrome.py), which then opens a new tab
#             (the Vyre page) and Chrome comes to the front. Nothing the agent writes there is read.
# What it looks like: a frosted bar floating a little above the bottom edge, centred, three large rounded icons (pictures drawn ahead of time, /usr/share/vyre-desk/dock), the icon under the
# pointer and its neighbours grow, a name above it, and a small dot under an app that is running. There is no compositor on the screen, so the glass is drawn (a picture of a frosted bar over the
# wallpaper's own dark) and the window is cut to the bar's rounded outline with the X SHAPE extension, through ctypes, so the corners show whatever is behind them. If SHAPE is refused the bar is
# a plain rectangle whose corners are the wallpaper's colour: it still looks right.
# No argument and no environment steer it: the folder, the socket, the FIFO, the display, the cookie and the pictures are built from the uid it runs as and from fixed paths.
import ctypes, os, subprocess, sys, time
import tkinter as tk

uid = os.geteuid()
if uid < 20000 or uid > 20063 or uid != os.getuid() or len(sys.argv) != 1:
    sys.exit(2)
USER = "ag%d" % uid
HOME = "/var/lib/vyre/agents/%s/home" % USER
TMUX = "/var/lib/vyre/agents/%s/tmux.sock" % USER
SHOW = "/var/lib/vyre/x/%s/show-chrome" % USER
DISPLAY = ":%d" % (20 + uid - 20000)
PICTURES = "/usr/share/vyre-desk/dock"
ENV = {"HOME": HOME, "USER": USER, "LOGNAME": USER, "SHELL": "/bin/bash", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "DISPLAY": DISPLAY, "XAUTHORITY": "/var/lib/vyre/x/%s/xauth" % USER}
# the file manager is a GTK program: dark, no accessibility bridge (the agent is not on the screen's accessibility bus), core input events (an untrusted client gets no XInput2)
FILES_ENV = dict(ENV, GTK_THEME="Adwaita:dark", NO_AT_BRIDGE="1", GDK_CORE_DEVICE_EVENTS="1")

# Vyre's dark Bone palette (docs/design/brand): warm ink on a warm near-black, one warm light. No violet (violet means "needs you").
WALL, INK, MUTED, BEAD = "#0E0D0C", "#F1EEE6", "#A8A39A", "#FFDFA8"
PILL, PILL_EDGE = "#2B2825", "#4B4741"
BAR_W, BAR_H, BAR_R = 276, 84, 26      # the bar's picture (panel.png) and its corner radius
SLOT = 84                               # each app's share of the bar's width
GAP = 14                                # between the bar and the bottom edge of the screen
REST, NEAR, UNDER = 56, 62, 68          # an icon at rest, beside the pointer, under it (the pictures' sizes)
BASE_Y = 72                             # icons stand on this line of the bar and grow upward
FONT = ("Liberation Sans", 11)
APPS = ("Chrome", "Terminal", "Files")
PICTURE_OF = {"Chrome": "browser", "Terminal": "terminal", "Files": "files"}

children = []


def spawn(argv, env):
    try:
        children.append((argv[0], subprocess.Popen(argv, cwd=HOME, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                                   start_new_session=True, close_fds=True)))
        return True
    except OSError:
        return False


def terminal():
    return spawn(["/usr/bin/xterm", "-T", "Terminal", "-n", "Terminal", "-fa", "Liberation Mono", "-fs", "11", "-bg", "#0E0D0C", "-fg", INK, "-cr", INK,
                  "-geometry", "110x32", "-e", "/usr/bin/tmux", "-S", TMUX, "new-session", "-A", "-s", "desk", "-c", HOME], ENV)


def files():
    return spawn(["/usr/bin/pcmanfm", HOME], FILES_ENV)


def chrome():
    try:
        fd = os.open(SHOW, os.O_WRONLY | os.O_NONBLOCK)
    except OSError:
        return False    # Chrome's holder is not running: the screen is still starting, or going to sleep
    try:
        os.write(fd, b"1")
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


ACTION = {"Chrome": chrome, "Terminal": terminal, "Files": files}


def running(name):
    if name == "Chrome":
        return os.path.exists(SHOW)     # the holder makes the button's FIFO when Chrome starts and removes it when Chrome ends
    want = "/usr/bin/xterm" if name == "Terminal" else "/usr/bin/pcmanfm"
    return any(a == want and p.poll() is None for a, p in children)


# ---- the window's outline (X SHAPE) -------------------------------------------------------------------------------------------------------------------------------------------------

def rounded_bitmap(w, h, r):
    # an X bitmap (rows padded to whole bytes, least significant bit first) that is set inside a rounded rectangle
    row = (w + 7) // 8
    data = bytearray(row * h)
    for y in range(h):
        dy = max(r - y, y - (h - 1 - r), 0)
        cut = 0
        if dy:
            cut = r - int(max(0.0, r * r - (dy - 0.5) ** 2) ** 0.5 + 0.5)
        for x in range(cut, w - cut):
            data[y * row + (x >> 3)] |= 1 << (x & 7)
    return bytes(data)


def shape_to(window, w, h, r):
    """Cut the X window to a rounded rectangle. True when the server took it."""
    try:
        x11, xext = ctypes.CDLL("libX11.so.6"), ctypes.CDLL("libXext.so.6")
        x11.XOpenDisplay.restype = ctypes.c_void_p
        x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x11.XCreateBitmapFromData.restype = ctypes.c_ulong
        x11.XCreateBitmapFromData.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_char_p, ctypes.c_uint, ctypes.c_uint]
        x11.XFreePixmap.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
        xext.XShapeCombineMask.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong, ctypes.c_int]
        failed = []
        handler_t = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
        handler = handler_t(lambda _d, _e: failed.append(1) or 0)    # an X error is an answer here, not the end of the dock
        x11.XSetErrorHandler.restype = ctypes.c_void_p
        x11.XSetErrorHandler.argtypes = [ctypes.c_void_p]
        old = x11.XSetErrorHandler(ctypes.cast(handler, ctypes.c_void_p))
        try:
            dpy = x11.XOpenDisplay(DISPLAY.encode())
            if not dpy:
                return False
            mask = rounded_bitmap(w, h, r)
            pm = x11.XCreateBitmapFromData(dpy, window, mask, w, h)
            xext.XShapeCombineMask(dpy, window, 0, 0, 0, pm, 0)   # ShapeBounding, at 0,0, ShapeSet
            x11.XSync(dpy, 0)
            x11.XFreePixmap(dpy, pm)
            x11.XCloseDisplay(dpy)
        finally:
            x11.XSetErrorHandler(old)       # Tk's own handler back
        return not failed
    except (OSError, AttributeError, ctypes.ArgumentError):
        return False


def floating(win):
    # no window frame, no focus, placed by hand; a window of this kind is raised by the dock itself (tick)
    try:
        win.overrideredirect(True)
    except tk.TclError:
        pass


root = tk.Tk(screenName=DISPLAY, className="VyreDock")
root.withdraw()
root.title("Dock")
floating(root)
root.configure(bg=WALL)
canvas = tk.Canvas(root, width=BAR_W, height=BAR_H, bg=WALL, highlightthickness=0, bd=0)
canvas.pack()
panel = tk.PhotoImage(file=os.path.join(PICTURES, "panel.png"))
canvas.create_image(0, 0, image=panel, anchor="nw")
pics = {name: {size: tk.PhotoImage(file=os.path.join(PICTURES, "%s-%d.png" % (PICTURE_OF[name], size))) for size in (REST, NEAR, UNDER)} for name in APPS}
cx = [(BAR_W - SLOT * len(APPS)) // 2 + SLOT * i + SLOT // 2 for i in range(len(APPS))]
items = [canvas.create_image(cx[i], BASE_Y, image=pics[n][REST], anchor="s") for i, n in enumerate(APPS)]
dots = [canvas.create_oval(cx[i] - 2, BAR_H - 8, cx[i] + 2, BAR_H - 4, fill=INK, outline="", state="hidden") for i in range(len(APPS))]

SX = (root.winfo_screenwidth() - BAR_W) // 2
SY = root.winfo_screenheight() - BAR_H - GAP
root.geometry("%dx%d+%d+%d" % (BAR_W, BAR_H, SX, SY))
root.resizable(False, False)


# ---- the name above an icon ---------------------------------------------------------------------------------------------------------------------------------------------------------

class Tip:
    def __init__(self):
        self.win = tk.Toplevel(root)
        self.win.withdraw()
        floating(self.win)
        self.win.configure(bg=WALL)
        self.c = tk.Canvas(self.win, bg=WALL, highlightthickness=0, bd=0)
        self.c.pack()
        self.shown = None
        self.size = (0, 0)

    def show(self, text, centre_x, warm=False):
        key = (text, warm)
        h = 28
        if self.shown != key:
            self.c.delete("all")
            probe = self.c.create_text(0, 0, text=text, font=FONT)
            x0, _, x1, _ = self.c.bbox(probe)
            self.c.delete(probe)
            w = int(x1 - x0) + 28
            self.c.configure(width=w, height=h)
            pts = [14, 0, w - 14, 0, w - 1, 0, w - 1, 14, w - 1, h - 1, w - 14, h - 1, 14, h - 1, 0, h - 1, 0, 14, 0, 0]
            self.c.create_polygon(pts, smooth=True, fill=PILL, outline=PILL_EDGE, width=1)
            self.c.create_text(w // 2, h // 2, text=text, font=FONT, fill=BEAD if warm else INK)
            self.win.geometry("%dx%d+%d+%d" % (w, h, SX + centre_x - w // 2, SY - h - 8))
            self.win.update_idletasks()
            if self.size != (w, h):
                self.size = (w, h)
                shape_to(self.win.winfo_id(), w, h, 14)
            self.shown = key
        else:
            self.win.geometry("+%d+%d" % (SX + centre_x - self.size[0] // 2, SY - h - 8))
        self.win.deiconify()
        self.win.lift()

    def hide(self):
        self.shown = None
        self.win.withdraw()


tip = Tip()
hover = None
notice = {}     # app name -> time until which its tooltip says "Not ready"
last = {}


def slot_at(x, y):
    if y < 0 or y >= BAR_H:
        return None
    i = (x - (BAR_W - SLOT * len(APPS)) // 2) // SLOT
    return int(i) if 0 <= i < len(APPS) else None


def layout():
    for i, name in enumerate(APPS):
        d = None if hover is None else abs(i - hover)
        size = UNDER if d == 0 else NEAR if d == 1 else REST
        canvas.itemconfigure(items[i], image=pics[name][size])
        canvas.itemconfigure(dots[i], state="normal" if running(name) else "hidden")
    if hover is None:
        tip.hide()
    else:
        name = APPS[hover]
        warm = notice.get(name, 0) > time.monotonic()
        tip.show("Not ready" if warm else name, cx[hover], warm)
    canvas.configure(cursor="hand2" if hover is not None else "")


def moved(e):
    global hover
    h = slot_at(e.x, e.y)
    if h != hover:
        hover = h
        layout()


def left(_e):
    global hover
    if hover is not None:
        hover = None
        layout()


def clicked(e):
    h = slot_at(e.x, e.y)
    if h is None:
        return
    name = APPS[h]
    now = time.monotonic()
    if now - last.get(name, 0) < 0.8:
        return      # a double click opens one window, not two
    last[name] = now
    if not ACTION[name]():
        notice[name] = now + 1.8
        layout()
        root.after(1900, layout)
    else:
        layout()


canvas.bind("<Motion>", moved)
canvas.bind("<Enter>", moved)
canvas.bind("<Leave>", left)
canvas.bind("<ButtonRelease-1>", clicked)
root.update_idletasks()
shape_to(root.winfo_id(), BAR_W, BAR_H, BAR_R)
layout()
root.deiconify()


def tick():
    # keep the dock in view (a window with no frame is never restacked by anyone else) and collect what has ended (a closed terminal, the file manager)
    root.lift()
    if hover is not None:
        tip.win.lift()
    for entry in list(children):
        if entry[1].poll() is not None:
            children.remove(entry)
    for i, name in enumerate(APPS):
        canvas.itemconfigure(dots[i], state="normal" if running(name) else "hidden")
    root.after(500, tick)


root.after(500, tick)
root.mainloop()
