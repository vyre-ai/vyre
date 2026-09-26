#!/bin/bash
# entrypoint: bring up the agent's desktop, in the order everything else depends on.
#
# Xvnc first (it is the X server; nothing else has a display until it exists), then the session
# bus (AT-SPI needs one to publish on), the window manager (AT-SPI and Chrome both assume
# something is mapping and focusing windows), Chrome (debugging port loopback-only, relayed
# outward by socat per ADR 0003), a terminal, and finally computerd in the foreground, which is
# what keeps the container alive: its exit is the container's exit.
#
# Runs under tini (the Dockerfile's ENTRYPOINT), so a `docker stop` SIGTERM reaches this script
# and, through it, computerd; tini reaps whatever computerd does not wait on.
#
# UNVALIDATED: written by inspection, never run. See the report to the lead for what to check
# once a real container can be built.

set -euo pipefail

SCREEN="${SCREEN:-1440x900}"
GEOMETRY="${SCREEN}x24"
: "${VNC_PASSWORD:?VNC_PASSWORD is required}"
: "${COMPUTERD_TOKEN:?COMPUTERD_TOKEN is required}"

log() { echo "[entrypoint] $*" >&2; }

# ---- Xvnc: the X server and the VNC server in one process --------------------------------
# TigerVNC wants the password obfuscated into its own file format, not passed raw on the command
# line (which would also put it in `ps`). `-SecurityTypes VncAuth` matches what Glass's rfb.js
# expects to negotiate (RFB security type 2) on the way in.
printf '%s' "${VNC_PASSWORD}" | vncpasswd -f > "${HOME}/.vnc/passwd"
chmod 600 "${HOME}/.vnc/passwd"

log "starting Xvnc ${DISPLAY} at ${GEOMETRY}"
Xvnc "${DISPLAY}" \
  -geometry "${GEOMETRY}" \
  -rfbport 5900 \
  -rfbauth "${HOME}/.vnc/passwd" \
  -SecurityTypes VncAuth \
  -localhost=no \
  -AlwaysShared \
  -SendCutText=1 -AcceptCutText=1 \
  &

for _ in $(seq 1 50); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || { log "Xvnc did not come up on ${DISPLAY}"; exit 1; }

# ---- the session bus: AT-SPI has nowhere to publish without one --------------------------
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
log "session bus at ${DBUS_SESSION_BUS_ADDRESS}"

# GTK/GLib apps only build an AT-SPI-visible tree when told to; Qt's equivalent is
# QT_ACCESSIBILITY, and Chromium is normally lazy about accessibility until asked.
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
export QT_ACCESSIBILITY=1

# ---- the window manager -------------------------------------------------------------------
log "starting fluxbox"
fluxbox >/home/agent/.fluxbox/log 2>&1 &

sleep 1

# ---- Chrome, debugging port loopback-only, relayed outward by socat ----------------------
# --remote-debugging-port binds loopback by default; the container's 9222 never needs to be
# reachable itself, only 9223 (ADR 0003's port table), which is why the relay exists at all
# rather than just publishing 9222.
log "starting chromium"
chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --force-renderer-accessibility \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="${HOME}/.chromium" \
  --window-size="${SCREEN%x*},${SCREEN#*x}" \
  --start-maximized \
  about:blank \
  >/home/agent/.chromium.log 2>&1 &

log "relaying 127.0.0.1:9222 -> 0.0.0.0:9223"
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &

# ---- a terminal, per computers.md's "a desktop, Chrome and a terminal" -------------------
xterm -geometry 100x30 &

# ---- computerd, in the foreground: its exit is the container's exit -----------------------
log "starting computerd"
exec node /opt/computerd/index.js
