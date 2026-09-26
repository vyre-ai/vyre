#!/bin/bash
# entrypoint: bring up the agent's desktop, in the order everything else depends on.
#
# Xvnc first (it is the X server; nothing else has a display until it exists), then the session
# bus (AT-SPI needs one to publish on), the window manager (AT-SPI and Chrome both assume
# something is mapping and focusing windows), Chrome (debugging port loopback-only, reached from
# outside this container only through computerd's authenticated /cdp proxy — see
# computerd/index.js; an earlier version relayed it out on its own unauthenticated port, which
# was a real hole), a terminal, and finally computerd in the foreground, which is what keeps the
# container alive: its exit is the container's exit.
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
# expects to negotiate (RFB security type 2) on the way in. The clipboard never leaves the
# computer (-SendCutText=0 -SendPrimary=0): whatever the agent copies, a Vault value included,
# would otherwise reach every watcher's browser (ADR 0005, decision 1). Nobody resizes the
# agent's screen under it (-AcceptSetDesktopSize=0), and 24 frames a second is plenty.
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
  -SendCutText=0 -SendPrimary=0 -AcceptCutText=1 -MaxCutText=262144 \
  -AcceptSetDesktopSize=0 -FrameRate=24 \
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

# ---- Chrome, debugging port loopback-only, proxied out by computerd only ------------------
# --remote-debugging-port binds loopback by default and stays that way: 9222 is never published
# and never relayed as a bare port. computerd (started below) is the only process that ever
# dials it, over its own authenticated /cdp routes (docs/adr/0012-cdp-proxy.md).
log "starting chromium"
# The profile lives on the home volume; a container that was killed leaves Chromium's Singleton
# locks behind, and the next Chromium then refuses to start with "profile in use".
rm -f "${HOME}/.chromium/SingletonLock" "${HOME}/.chromium/SingletonSocket" "${HOME}/.chromium/SingletonCookie"
# The few sites that go out through the user's Mac (config glass.egress, core/computers/egress.js):
# vyred passes the proxy script as a data: URL only when the setting is on and lists a site.
# Checked against that exact shape, so nothing else ever reaches Chrome's command line through it.
# WebRTC is kept off UDP that bypasses the proxy, or a listed site could still learn this box's
# own address from a STUN reply.
proxy_flags=()
if [ -n "${VYRE_PROXY_PAC:-}" ]; then
  if [[ "${VYRE_PROXY_PAC}" =~ ^data:application/x-ns-proxy-autoconfig\;base64,[A-Za-z0-9+/]+=*$ ]]; then
    proxy_flags=(--proxy-pac-url="${VYRE_PROXY_PAC}" --force-webrtc-ip-handling-policy=disable_non_proxied_udp)
    log "chromium: listed sites go through the egress proxy"
  else
    log "VYRE_PROXY_PAC is not a PAC data: URL; refusing to start Chrome without the sites it lists"
    exit 1
  fi
fi
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
  ${proxy_flags[@]+"${proxy_flags[@]}"} \
  about:blank \
  >/home/agent/.chromium.log 2>&1 &

# ---- a terminal, per computers.md's "a desktop, Chrome and a terminal" -------------------
xterm -geometry 100x30 &

# ---- computerd, in the foreground: its exit is the container's exit -----------------------
log "starting computerd"
exec node /opt/computerd/index.js
