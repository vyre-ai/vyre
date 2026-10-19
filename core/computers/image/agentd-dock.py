#!/usr/bin/python3 -I
# agentd-dock: the dock at the bottom of an agent's screen, with three buttons and nothing else: Chrome, Terminal and Files (owner, 20 Oct 2026). It runs AS the agent's own uid
# (ag20000..ag20063) with the agent's UNTRUSTED X cookie, like any window the agent opens: it can draw its own window and cannot read, grab or type into anyone else's.
#   Terminal  opens a terminal in the agent's folder, on the agent's own tmux (session "desk"), so what runs there keeps running when the screen sleeps and is one of the
#             agent's terminals in Vyre too (agentd-term.py uses the same socket).
#   Files     opens the file manager on the agent's folder. It runs as the agent, so it reaches exactly what the agent's uid may: its own folder, and Downloads (read only).
#   Chrome    Chrome is the browser uid's, which the agent cannot start or reach. The button writes one byte to the holder's FIFO (agentd-chrome.py), which then opens a blank tab
#             and Chrome comes to the front. Nothing the agent writes there is read.
# No argument and no environment steer it: the folder, the socket, the FIFO, the display and the cookie are built from the uid it runs as.
import os, subprocess, sys, time
import tkinter as tk

uid = os.geteuid()
if uid < 20000 or uid > 20063 or uid != os.getuid() or len(sys.argv) != 1:
    sys.exit(2)
USER = "ag%d" % uid
HOME = "/var/lib/vyre/agents/%s/home" % USER
TMUX = "/var/lib/vyre/agents/%s/tmux.sock" % USER
SHOW = "/var/lib/vyre/x/%s/show-chrome" % USER
DISPLAY = ":%d" % (20 + uid - 20000)
ENV = {"HOME": HOME, "USER": USER, "LOGNAME": USER, "SHELL": "/bin/bash", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8",
       "DISPLAY": DISPLAY, "XAUTHORITY": "/var/lib/vyre/x/%s/xauth" % USER}
# the file manager is a GTK program: dark, no accessibility bridge (the agent is not on the screen's accessibility bus), core input events (an untrusted client gets no XInput2)
FILES_ENV = dict(ENV, GTK_THEME="Adwaita:dark", NO_AT_BRIDGE="1", GDK_CORE_DEVICE_EVENTS="1")

# Vyre's dark Bone palette (docs/design/brand): warm ink on a warm near-black, one warm light. No violet (violet means "needs you").
BG, EDGE, HOVER, INK, MUTED, BEAD = "#1A1816", "#2C2824", "#26231F", "#F1EEE6", "#A8A39A", "#FFDFA8"
TILE_W, TILE_H, GAP, PAD_X, PAD_Y, BOTTOM = 76, 72, 6, 10, 8, 12
FONT = ("Liberation Sans", 9)


def rounded(c, x0, y0, x1, y1, r, **kw):
    pts = [x0 + r, y0, x1 - r, y0, x1, y0, x1, y0 + r, x1, y1 - r, x1, y1, x1 - r, y1, x0 + r, y1, x0, y1, x0, y1 - r, x0, y0 + r, x0, y0]
    return c.create_polygon(pts, smooth=True, **kw)


def draw_chrome(c, x, y):
    # a browser window with a bead of light in its address bar: Vyre for Chrome's own sign, never Chrome's logo
    rounded(c, x, y + 3, x + 32, y + 29, 5, outline=INK, fill="", width=2)
    c.create_line(x + 1, y + 11, x + 31, y + 11, fill=INK, width=2)
    c.create_oval(x + 5, y + 5, x + 9, y + 9, fill=BEAD, outline="")
    c.create_line(x + 12, y + 7, x + 26, y + 7, fill=MUTED, width=2, capstyle="round")


def draw_terminal(c, x, y):
    rounded(c, x, y + 3, x + 32, y + 29, 5, outline=INK, fill="", width=2)
    c.create_line(x + 7, y + 11, x + 13, y + 16, x + 7, y + 21, fill=INK, width=2, capstyle="round", joinstyle="round")
    c.create_line(x + 16, y + 22, x + 25, y + 22, fill=BEAD, width=2, capstyle="round")


def draw_files(c, x, y):
    c.create_polygon(x + 1, y + 6, x + 12, y + 6, x + 15, y + 10, x + 31, y + 10, x + 31, y + 28, x + 1, y + 28, outline=INK, fill="", width=2, joinstyle="round")
    c.create_line(x + 1, y + 14, x + 31, y + 14, fill=MUTED, width=2)


children = []


def spawn(argv, env):
    try:
        children.append(subprocess.Popen(argv, cwd=HOME, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                         start_new_session=True, close_fds=True))
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


root = tk.Tk(screenName=DISPLAY, className="VyreDock")
root.withdraw()
root.title("Dock")
try:
    root.wm_attributes("-type", "dock")     # the window manager keeps it above other windows, undecorated, and never focuses it
except tk.TclError:
    pass
root.configure(bg=BG, highlightthickness=1, highlightbackground=EDGE, highlightcolor=EDGE)
bar = tk.Frame(root, bg=BG)
bar.pack(padx=PAD_X, pady=PAD_Y)

last = {}


def tile(i, name, draw, act):
    c = tk.Canvas(bar, width=TILE_W, height=TILE_H, bg=BG, highlightthickness=0, cursor="hand2")
    c.grid(row=0, column=i, padx=(0 if i == 0 else GAP, 0))
    draw(c, (TILE_W - 32) // 2, 8)
    label = c.create_text(TILE_W // 2, TILE_H - 12, text=name, fill=MUTED, font=FONT)
    c.bind("<Enter>", lambda _e: c.configure(bg=HOVER))
    c.bind("<Leave>", lambda _e: c.configure(bg=BG))

    def click(_e):
        now = time.monotonic()
        if now - last.get(name, 0) < 0.8:
            return      # a double click opens one window, not two
        last[name] = now
        if not act():
            c.itemconfigure(label, text="Not ready", fill=BEAD)
            c.after(1800, lambda: c.itemconfigure(label, text=name, fill=MUTED))
    c.bind("<ButtonRelease-1>", click)


for i, (name, draw, act) in enumerate([("Chrome", draw_chrome, chrome), ("Terminal", draw_terminal, terminal), ("Files", draw_files, files)]):
    tile(i, name, draw, act)

W = 3 * TILE_W + 2 * GAP + 2 * PAD_X + 2
H = TILE_H + 2 * PAD_Y + 2
root.geometry("%dx%d+%d+%d" % (W, H, (root.winfo_screenwidth() - W) // 2, root.winfo_screenheight() - H - BOTTOM))
root.resizable(False, False)
root.deiconify()


def tick():
    # keep the dock in view and collect what has ended (a closed terminal, the file manager)
    root.lift()
    for p in list(children):
        if p.poll() is not None:
            children.remove(p)
    root.after(1500, tick)


root.after(1500, tick)
root.mainloop()
