#!/bin/bash
# entrypoint: bring up the agent's desktop, in the order everything else depends on, each part
# under the user it belongs to.
#
# Two users (the Dockerfile makes them):
#   vyre  (uid 1001)  Xvnc, the session bus, computerd, and Chrome (computerd's child). Its home
#                     is its own volume at /var/lib/vyre: the Chrome profile, the VNC password.
#   agent (uid 1000)  the terminal the agent works in (xterm), and everything it starts. While
#                     the shield is up (a person signing in, a Vault fill) all of it is stopped.
#   fluxbox, the window manager, is vyre's too.
# The agent's processes cannot trace, signal or read the environment of vyre's (a different uid,
# no CAP_SYS_PTRACE), cannot reach Chrome's DevTools (computerd holds them over a pipe, there is
# no port), and never see COMPUTERD_TOKEN or VNC_PASSWORD (their environment is built from
# nothing below). vyre is in the agent's group, so computerd serves Glass's Files on the agent's
# home and Chrome can save downloads there.
#
# This script starts as root only to switch users: the container gets exactly CAP_SETUID and
# CAP_SETGID (policy.js), with no-new-privileges and a read-only root, and every process below is
# started through setpriv, which leaves it no capability at all. tini (PID 1) stays root and does
# nothing but reap.
#
# Order: Xvnc (the X server; nothing has a display until it exists), the session bus (AT-SPI
# publishes on it), the window manager, a terminal, and finally computerd in the foreground,
# which starts Chrome with --remote-debugging-pipe and keeps the container alive: its exit is
# the container's exit.

set -euo pipefail

SCREEN="${SCREEN:-1440x900}"
GEOMETRY="${SCREEN}x24"
# The secrets are never in this environment: vyred puts them in /var/lib/vyre/.boot (0400, vyre)
# before each start, because Docker hands a container's Env to every exec in it. This script,
# root without DAC_OVERRIDE, cannot even read the file; vyre's processes do.
BOOT_FILE=/var/lib/vyre/.boot
if [ -n "${COMPUTERD_TOKEN:-}${VNC_PASSWORD:-}" ]; then
  echo "[entrypoint] refusing to start: the computer's secrets are in its environment (an old vyred?); they belong in ${BOOT_FILE}" >&2
  exit 1
fi
VYRE_HOME=/var/lib/vyre
AGENT_HOME=/home/agent
# X cookies: vyre's is trusted (Xvnc's -auth file); the agent's is an untrusted one the SECURITY
# extension issues, so nothing the agent runs can read Chrome's pixels, send it events or use
# XTEST. It lives in /run/vyre-x, which the agent can read but not change.
VYRE_XAUTH="${VYRE_HOME}/.Xauthority"
AGENT_XAUTH=/run/vyre-x/agent.xauth
PATH_SAFE=/usr/local/bin:/usr/bin:/bin

log() { echo "[entrypoint] $*" >&2; }

if [ "$(id -u)" != 0 ]; then
  log "must start as root to put the agent and Chrome under different users; this image needs vyred with the uid split (CapAdd SETUID, SETGID)"
  exit 1
fi

# Run as vyre or as the agent, with no capability left and an environment built from nothing.
# The agent's umask keeps new files group-writable, so computerd (in its group) can save uploads.
as_vyre() {
  setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- \
    env -i HOME="${VYRE_HOME}" USER=vyre LOGNAME=vyre PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
      XAUTHORITY="${VYRE_XAUTH}" "$@"
}
as_agent() {
  setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all -- \
    env -i HOME="${AGENT_HOME}" USER=agent LOGNAME=agent SHELL=/bin/bash PATH="${PATH_SAFE}" \
      LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" XAUTHORITY="${AGENT_XAUTH}" TERM=xterm \
    /bin/sh -c 'umask 002; exec "$@"' sh "$@"
}

# ---- the two homes ---------------------------------------------------------------------------
# The agent's home is group-writable (setgid, so new folders keep the group) for computerd's
# Files; the agent can undo that for any folder it wants private.
as_agent sh -c 'chmod 2775 "$HOME" && mkdir -p "$HOME/.fluxbox"'
as_vyre sh -c 'umask 077; mkdir -p "$HOME/.vnc" "$HOME/chromium"'
# Downloads: not under the agent's home (e2e review MEDIUM 3). The agent owns /home/agent
# outright and could rename a Downloads folder there for a symlink into /var/lib/vyre, which
# Chrome (vyre's own uid) would then follow. vyre owns this one instead, group agent, 2750: vyre
# (Chrome) writes into it, the agent can list and read what lands there, neither can rename or
# replace the folder itself out from under the other.
as_vyre sh -c 'umask 027; mkdir -p "$HOME/downloads"; chgrp agent "$HOME/downloads"; chmod 2750 "$HOME/downloads"'

# Once, from a computer made before the split: carry the agent's sign-ins over (cookies and
# local storage only). Nothing else crosses: an old profile was the agent's to write, and its
# extensions or preferences are not to be trusted by a Chrome the agent must not control. The
# agent reads the old files and vyre writes the new ones; neither can do the other's half.
if [ -d "${AGENT_HOME}/.chromium/Default" ] && [ ! -e "${VYRE_HOME}/chromium/.migrated" ]; then
  log "carrying the agent's Chrome sign-ins into the protected profile"
  as_agent sh -c 'cd "$HOME/.chromium/Default" && tar -cf - --ignore-failed-read Cookies Cookies-journal "Local Storage" 2>/dev/null || true' \
    | as_vyre sh -c 'umask 077; mkdir -p "$HOME/chromium/Default" && tar -C "$HOME/chromium/Default" -xf - --no-same-owner --no-same-permissions || true'
  as_vyre touch "${VYRE_HOME}/chromium/.migrated"
  as_agent rm -rf "${AGENT_HOME}/.chromium" "${AGENT_HOME}/.chromium.log"
fi

# ---- Xvnc: the X server and the VNC server in one process, as vyre ----------------------------
# TigerVNC wants the password obfuscated into its own file format, not passed raw on the command
# line (which would also put it in `ps`). `-SecurityTypes VncAuth` matches what Glass's rfb.js
# expects to negotiate (RFB security type 2) on the way in. The clipboard never leaves the
# computer (-SendCutText=0 -SendPrimary=0): whatever the agent copies, a Vault value included,
# would otherwise reach every watcher's browser (ADR 0005, decision 1). Nobody resizes the
# agent's screen under it (-AcceptSetDesktopSize=0), and 24 frames a second is plenty. X itself
# listens on its unix socket only (-nolisten tcp); -localhost=no is about VNC's 5900, for vyred.
as_vyre sh -c 'test -r "$0"' "${BOOT_FILE}" || { log "no ${BOOT_FILE}: vyred seeds it before start"; exit 1; }
as_vyre sh -c 'umask 077; sed -n "s/^VNC_PASSWORD=//p" "$0" | tr -d "\n" | vncpasswd -f > "$HOME/.vnc/passwd"' "${BOOT_FILE}"
# A fresh trusted cookie every start, known only to vyre's processes.
as_vyre sh -c 'umask 077; rm -f "$XAUTHORITY"; xauth -q add "$DISPLAY" . "$(mcookie)"'

log "starting Xvnc ${DISPLAY} at ${GEOMETRY}"
as_vyre Xvnc "${DISPLAY}" \
  -geometry "${GEOMETRY}" \
  -rfbport 5900 \
  -rfbauth "${VYRE_HOME}/.vnc/passwd" \
  -auth "${VYRE_XAUTH}" \
  +extension SECURITY \
  -SecurityTypes VncAuth \
  -localhost=no \
  -nolisten tcp \
  -AlwaysShared \
  -SendCutText=0 -SendPrimary=0 -AcceptCutText=1 -MaxCutText=262144 \
  -AcceptSetDesktopSize=0 -FrameRate=24 \
  &

for _ in $(seq 1 50); do
  as_vyre xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.2
done
as_vyre xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || { log "Xvnc did not come up on ${DISPLAY}"; exit 1; }
# Access by cookie only: no host or local-user exceptions, so a client without one is refused.
as_vyre xhost - >/dev/null
for entry in $(as_vyre xhost 2>/dev/null | tail -n +2); do as_vyre xhost "-${entry}" >/dev/null 2>&1 || true; done
# The agent's cookie: untrusted, never timing out. The folder and file are root's and readable to
# all, so the agent can use the cookie but never swap in another; an untrusted cookie is no secret.
mkdir -p /run/vyre-x && chmod 0755 /run/vyre-x
as_vyre sh -c 'umask 027; xauth -q -f /tmp/.agent.xauth generate "$DISPLAY" . untrusted timeout 0' \
  || { log "Xvnc has no SECURITY extension; refusing to give the agent a trusted display"; exit 1; }
as_vyre sh -c 'cat /tmp/.agent.xauth' > "${AGENT_XAUTH}.new" && as_vyre rm -f /tmp/.agent.xauth
chmod 0644 "${AGENT_XAUTH}.new" && mv "${AGENT_XAUTH}.new" "${AGENT_XAUTH}"

# ---- the session bus, vyre's: AT-SPI for computerd and Chrome -------------------------------
# The agent's processes are not on it (the bus admits its own uid only), so nothing the agent
# runs can read Chrome's accessibility tree, a form being filled included.
bus="$(as_vyre dbus-launch --sh-syntax)"
DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "${bus}" | sed -n "s/^DBUS_SESSION_BUS_ADDRESS='\(.*\)';$/\1/p")"
DBUS_SESSION_BUS_PID="$(printf '%s\n' "${bus}" | sed -n "s/^DBUS_SESSION_BUS_PID=\([0-9]*\);$/\1/p")"
log "session bus at ${DBUS_SESSION_BUS_ADDRESS}"

# ---- the desktop: the window manager as vyre, the terminal as the agent ------------------------
# fluxbox is vyre's: the agent's processes are stopped during a sign-in (below), and a stopped
# window manager would never map the window a fill opens.
log "starting fluxbox (vyre) and xterm (the agent)"
# No wallpaper: fbsetbg's error dialog would otherwise sit on the screen Glass shows.
as_vyre sh -c 'mkdir -p "$HOME/.fluxbox" && echo "background: none" > "$HOME/.fluxbox/overlay" && exec fluxbox >"$HOME/.fluxbox/log" 2>&1' &
sleep 1
as_agent xterm -geometry 100x30 &

# ---- the freezer: stops the agent's processes while the shield is up --------------------------
# computerd writes "stop" or "cont" to fd 9; this root loop does it as the agent's uid, which may
# signal exactly the agent's processes (kill -1 as uid 1000 reaches uid 1000 and nothing else).
# When computerd exits, the pipe closes and everything the agent runs is continued.
# Stopping sweeps three times, so a process that forked during one sweep is caught by the next.
# The image has no kill binary, only the shell's builtin: bash runs it as the agent's uid.
signal_agent() { setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all -- /bin/bash -c "kill -s $1 -1" 2>/dev/null || true; }
freezer() {
  while IFS= read -r cmd; do
    case "${cmd}" in
      stop) for _ in 1 2 3; do signal_agent STOP; sleep 0.05; done ;;
      cont) signal_agent CONT ;;
    esac
  done
  signal_agent CONT
}
exec 9> >(freezer)

# ---- computerd, in the foreground, as vyre: its exit is the container's exit ------------------
# Only what computerd needs, named one by one. GTK_MODULES and friends make Chromium build an
# AT-SPI-visible tree; computerd passes them on to Chrome.
log "starting computerd (it starts chromium)"
exec setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- \
  env -i HOME="${VYRE_HOME}" USER=vyre LOGNAME=vyre PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS}" DBUS_SESSION_BUS_PID="${DBUS_SESSION_BUS_PID}" XAUTHORITY="${VYRE_XAUTH}" \
    GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 QT_ACCESSIBILITY=1 \
    COMPUTERD_TOKEN_FILE="${BOOT_FILE}" SCREEN="${SCREEN}" ${VYRE_PROXY_PAC:+VYRE_PROXY_PAC="${VYRE_PROXY_PAC}"} \
    ${COMPUTERD_PORT:+COMPUTERD_PORT="${COMPUTERD_PORT}"} \
    CHROME_PROFILE="${VYRE_HOME}/chromium" CHROME_LOG="${VYRE_HOME}/chromium.log" COMPUTERD_FS_ROOT="${AGENT_HOME}" \
    AGENT_DOWNLOADS="${VYRE_HOME}/downloads" \
    VYRE_FREEZE_FD=9 \
  node /opt/computerd/index.js
