#!/bin/bash
# entrypoint: bring up the agent's desktop, in the order everything else depends on, each part
# under the user it belongs to.
#
# Three users (the Dockerfile makes them):
#   vyre    (uid 1001)  Xvnc, the session bus and computerd. Its home is its own volume at
#                       /var/lib/vyre: the VNC password, the boot secrets, its own X cookie.
#   browser (uid 1002)  Chrome, and nothing else -- launched by THIS script (root), never by
#                       computerd (the reviewer's root-launcher design, 28 Sep, replacing an
#                       earlier one where computerd itself spawned Chrome under this uid, which
#                       needed computerd to keep CAP_SETUID/CAP_SETGID for its whole life: ambient
#                       capabilities survive a uid change between two non-zero uids, so a
#                       computerd compromise could have used them to become vyre, or root, undoing
#                       the whole split). computerd only ever talks to Chrome over the two FIFOs
#                       below (chrome_loop), never touching its process, its uid, or a capability.
#                       A different uid from vyre's, so a Chrome exploit cannot read
#                       /var/lib/vyre's secrets or vyre's own X cookie by path, even though it
#                       lives inside the same volume (see the Dockerfile's note on
#                       /var/lib/vyre/browser). Reaches the AT-SPI bus only through the vyre-bus
#                       group (Dockerfile), never by uid.
#   agent   (uid 1000)  the terminal the agent works in (xterm), and everything it starts. While
#                       the shield is up (a person signing in, a Vault fill) all of it is stopped.
#   fluxbox, the window manager, is vyre's too.
# The agent's processes cannot trace, signal or read the environment of vyre's or browser's (a
# different uid, no CAP_SYS_PTRACE), cannot reach Chrome's DevTools (computerd holds them over a
# pipe, there is no port), and never see COMPUTERD_TOKEN or VNC_PASSWORD (their environment is
# built from nothing below). vyre is in the agent's group, so computerd serves Glass's Files on
# the agent's home; browser is in the agent's group on the downloads folder only (below), so
# Chrome can save there and the agent can read what lands.
#
# This script starts as root only to switch users: the container gets exactly CAP_SETUID and
# CAP_SETGID (policy.js), with no-new-privileges and a read-only root, and every process below --
# computerd included, now -- is started through setpriv with `--inh-caps=-all`, which leaves it no
# capability at all; Chrome (chrome_loop) additionally gets `--ambient-caps=-all --bounding-set=-
# all`, stripping even what a uid-0-to-nonzero transition would otherwise leave available to a
# later exec inside it. tini (PID 1) stays root and does nothing but reap.
#
# Order: Xvnc (the X server; nothing has a display until it exists), the session bus (AT-SPI
# publishes on it), the window manager, a terminal, and finally computerd in the foreground,
# which starts Chrome (as browser, not itself) with --remote-debugging-pipe and keeps the
# container alive: its exit is the container's exit.

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
BROWSER_HOME="${VYRE_HOME}/browser"
# X cookies: vyre's is trusted (Xvnc's -auth file); the agent's and browser's are untrusted ones
# the SECURITY extension issues, one each, so nothing either runs can read Chrome's pixels, send
# it events or use XTEST -- browser gets its own rather than reusing the agent's so a Chrome
# exploit and a stopped agent process are never granted through the same cookie. Both live in
# /run/vyre-x, which their own uid can read but not change.
VYRE_XAUTH="${VYRE_HOME}/.Xauthority"
AGENT_XAUTH=/run/vyre-x/agent.xauth
BROWSER_XAUTH=/run/vyre-x/browser.xauth
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
# For the one-time provisioning this script itself does under browser's uid (its X cookie, the
# profile-directory upkeep below) -- Chrome itself runs through chrome_once/chrome_loop further
# down, its own dedicated setpriv call with extra hardening, not through this helper.
as_browser() {
  setpriv --reuid=1002 --regid=1002 --init-groups --inh-caps=-all -- \
    env -i HOME="${BROWSER_HOME}" USER=browser LOGNAME=browser PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
      XAUTHORITY="${BROWSER_XAUTH}" "$@"
}

# ---- Chrome's two FIFOs, made before any agent process runs -----------------------------------
# The reviewer's HIGH (28 Sep): the agent's home starts empty, but xterm (further down) gives the
# agent an interactive shell that runs its own .bashrc from its persistent volume -- if this ran
# after that, the agent could win a race and plant its own directory (or a symlink) at this exact
# path first. mkfifo would then succeed inside the agent's own directory, and Chrome's fd 3/4
# would belong to the agent: raw CDP to the browser target, bypassing cdpmux (cookie dumps,
# file://, everything cdpmux.js refuses). Made this early instead, and under /var/lib/vyre (vyre's
# own volume, 0711), not /tmp: vyre owns that path outright, can mkdir and chgrp to vyre-bus with
# no CAP_CHOWN, and it is nowhere the agent's own uid can write to plant something first.
# Every step here fails closed (a bare `mkdir`, never `-p`, refuses to reuse anything already at
# that name; `|| exit 1` on every following chgrp/chmod, since none of them should ever legitimately
# fail and a silent `&&` short-circuit under set -e would otherwise let the boot continue with the
# wrong owner or mode on a path the rest of this script trusts).
CHROME_DIR="${VYRE_HOME}/chrome-pipes"
CHROME_IN="${CHROME_DIR}/in"    # computerd writes, Chrome reads (its fd 3)
CHROME_OUT="${CHROME_DIR}/out"  # Chrome writes (its fd 4), computerd reads
CHROME_PROFILE="${BROWSER_HOME}/chromium"
CHROME_LOG="${VYRE_HOME}/chromium.log"
# The reviewer's HIGH (28 Sep, on the fix above): /var/lib/vyre is the computer's own named
# volume, kept across a stop/start, a box reboot and a Docker restart (computers.stop -> start
# never removes it, and even a remove uses v=false) -- so a first boot's own chrome-pipes/ is
# still sitting there on every later boot, and the bare mkdir below would refuse it as if an
# attacker had planted it. Removed first, as vyre: /var/lib/vyre is vyre's own 0711 directory (not
# world-writable, not the agent's), so nothing but vyre or root could have left anything there to
# remove, and `rm -rf` never follows a symlink at the top level it is given -- it unlinks it.
as_vyre rm -rf -- "${CHROME_DIR}" || exit 1
as_vyre sh -c 'umask 007; mkdir "$0"' "${CHROME_DIR}" \
  || { log "${CHROME_DIR} already exists; refusing to reuse it for Chrome's FIFOs"; exit 1; }
as_vyre sh -c '[ -d "$0" ] && [ ! -L "$0" ]' "${CHROME_DIR}" \
  || { log "${CHROME_DIR} is not a plain directory; refusing"; exit 1; }
[ "$(stat -c %U "${CHROME_DIR}")" = "vyre" ] \
  || { log "${CHROME_DIR} is not vyre's; refusing"; exit 1; }
as_vyre chgrp vyre-bus "${CHROME_DIR}" || exit 1
as_vyre chmod 0770 "${CHROME_DIR}" || exit 1
as_vyre mkfifo -m 0660 "${CHROME_IN}" "${CHROME_OUT}" || exit 1
as_vyre chgrp vyre-bus "${CHROME_IN}" "${CHROME_OUT}" || exit 1
as_vyre chmod 0660 "${CHROME_IN}" "${CHROME_OUT}" || exit 1
as_vyre sh -c ': > "$0"' "${CHROME_LOG}" 2>/dev/null || true
# browser writes its own stdout/stderr into this file (below); vyre reads it. Same vyre-bus
# pattern as the FIFOs: vyre owns it and may hand it to a group it belongs to.
as_vyre chgrp vyre-bus "${CHROME_LOG}" || exit 1
as_vyre chmod 0660 "${CHROME_LOG}" || exit 1

# ---- the three homes -------------------------------------------------------------------------
# The agent's home is group-writable (setgid, so new folders keep the group) for computerd's
# Files; the agent can undo that for any folder it wants private.
as_agent sh -c 'chmod 2775 "$HOME" && mkdir -p "$HOME/.fluxbox"'
as_vyre sh -c 'umask 077; mkdir -p "$HOME/.vnc"'
# browser's own subtree (the Chrome profile, downloads) is pre-made by the Dockerfile with its
# final ownership already on it -- a fresh volume copies that as-is, so nothing here needs to
# mkdir or chown it. Downloads stays out of the agent's home (e2e review MEDIUM 3: the agent owns
# /home/agent outright and could rename a Downloads folder there for a symlink into /var/lib/vyre,
# which Chrome would then follow) and out of browser's own profile folder too (a Chrome exploit
# that can write its profile should not also be able to plant something under the folder the
# agent later reads from). browser owns it, group agent, 2750: browser (Chrome) writes into it,
# the agent can list and read what lands there, neither can rename or replace the folder itself
# out from under the other. These two lines just confirm the modes an old volume's image layer
# might predate; both are no-ops on a volume made from the current image.
as_browser sh -c 'chmod 0700 "$HOME/chromium"' 2>/dev/null || true
as_browser sh -c 'chgrp agent "$HOME/downloads" && chmod 2750 "$HOME/downloads"' 2>/dev/null || true

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

# Once more, from a computer made before browser got its own uid: carry vyre's own protected
# profile over to browser's (the same shape as the migration above, one hop later). vyre cannot
# chown its old chromium/ to browser (no CAP_CHOWN), so this is a copy, not a move: vyre reads its
# old files, browser writes the new ones, and vyre's old copy is removed once the write lands.
if [ -d "${VYRE_HOME}/chromium/Default" ] && [ ! -e "${BROWSER_HOME}/chromium/.migrated" ]; then
  log "carrying the protected profile from vyre's uid into browser's"
  as_vyre sh -c 'cd "$HOME/chromium/Default" && tar -cf - --ignore-failed-read Cookies Cookies-journal "Local Storage" 2>/dev/null || true' \
    | as_browser sh -c 'umask 077; mkdir -p "$HOME/chromium/Default" && tar -C "$HOME/chromium/Default" -xf - --no-same-owner --no-same-permissions || true'
  as_browser touch "${BROWSER_HOME}/chromium/.migrated"
  as_vyre rm -rf "${VYRE_HOME}/chromium" "${VYRE_HOME}/chromium.log"
fi

# ---- Xvnc: the X server and the VNC server in one process, as vyre ----------------------------
# TigerVNC wants the password obfuscated into its own file format, not passed raw on the command
# line (which would also put it in `ps`). `-SecurityTypes VncAuth` matches what Glass's rfb.js
# expects to negotiate (RFB security type 2) on the way in. The clipboard never leaves the
# computer (-SendCutText=0 -SendPrimary=0): whatever the agent copies, a Vault value included,
# would otherwise reach every watcher's browser (ADR 0005, decision 1). Nobody resizes the
# agent's screen under it (-AcceptSetDesktopSize=0), and 24 frames a second is plenty. X itself
# listens on its unix socket only (-nolisten tcp); -localhost=no is about VNC's 5900, for vyred.
# BlacklistThreshold: Xvnc blacklists a host after 5 unauthenticated connections (default), and the pool's own
# readiness probes of 5900 are such connections from vyred's address. On a slower host the probes alone reach 5
# and Glass then gets Xvnc's "RFB 003.003" refusal ("Too many security failures") instead of a handshake, so Glass
# fails with "does not speak RFB 3.8" (seen on a GitHub runner, J7). Only vyred can reach 5900 (the network is
# internal), so a threshold well above the probes loses nothing. (That is NOT true today: all computers share
# one Docker network with inter-container traffic on, so one computer can dial another's 5900 and 7000. The
# VNC password and computerd's token are the only walls; the J7 matrix step 7.4 proves the reach.)
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
  -BlacklistThreshold=50 \
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
# browser's cookie: its own, untrusted, never timing out -- never the agent's, and never vyre's
# trusted one (browser has no business ever holding a cookie that can XTEST or resize the
# display).
as_vyre sh -c 'umask 027; xauth -q -f /tmp/.browser.xauth generate "$DISPLAY" . untrusted timeout 0' \
  || { log "Xvnc has no SECURITY extension; refusing to give Chrome a display"; exit 1; }
as_vyre sh -c 'cat /tmp/.browser.xauth' > "${BROWSER_XAUTH}.new" && as_vyre rm -f /tmp/.browser.xauth
chmod 0644 "${BROWSER_XAUTH}.new" && mv "${BROWSER_XAUTH}.new" "${BROWSER_XAUTH}"

# ---- the session bus, vyre's: AT-SPI for computerd and Chrome -------------------------------
# The agent's processes are not on it (dbus-launch puts its socket directly in the shared, sticky
# /tmp on this dbus -- not its own private directory, checked live on testbox, 28 Sep -- so the
# socket FILE's own mode is the only thing guarding it), so nothing the agent runs can read
# Chrome's accessibility tree, a form being filled included. browser (Chrome) still needs it --
# AT-SPI is how computerd reads Chrome's own tree -- so vyre, the socket's owner (dbus-launch ran
# as vyre), chgrp's that one file to vyre-bus (a group vyre is already a member of, which needs no
# CAP_CHOWN: an owner may hand a file to any group they belong to) and locks its mode down to that
# group only. agent is not in vyre-bus, so this changes nothing for it. Never touch /tmp itself:
# it is shared with the agent's own untrusted processes.
bus="$(as_vyre dbus-launch --sh-syntax)"
DBUS_SESSION_BUS_ADDRESS="$(printf '%s\n' "${bus}" | sed -n "s/^DBUS_SESSION_BUS_ADDRESS='\(.*\)';$/\1/p")"
DBUS_SESSION_BUS_PID="$(printf '%s\n' "${bus}" | sed -n "s/^DBUS_SESSION_BUS_PID=\([0-9]*\);$/\1/p")"
log "session bus at ${DBUS_SESSION_BUS_ADDRESS}"
bus_sock="$(printf '%s\n' "${DBUS_SESSION_BUS_ADDRESS}" | sed -n 's#^unix:path=\([^,]*\).*#\1#p')"
if [ -n "${bus_sock}" ] && [ -e "${bus_sock}" ]; then
  as_vyre chgrp vyre-bus "${bus_sock}" && as_vyre chmod 0660 "${bus_sock}"
else
  log "could not find the session bus's own socket in '${DBUS_SESSION_BUS_ADDRESS}'; browser will not reach AT-SPI"
fi
# ---- the desktop: the window manager as vyre, the terminal as the agent ------------------------
# fluxbox is vyre's: the agent's processes are stopped during a sign-in (below), and a stopped
# window manager would never map the window a fill opens.
log "starting fluxbox (vyre) and xterm (the agent)"
# No wallpaper: fbsetbg's error dialog would otherwise sit on the screen Glass shows.
as_vyre sh -c 'mkdir -p "$HOME/.fluxbox" && echo "background: none" > "$HOME/.fluxbox/overlay" && exec fluxbox >"$HOME/.fluxbox/log" 2>&1' &
sleep 1
as_agent xterm -geometry 100x30 &

# AT-SPI's OWN bus (org.a11y.Bus) is not the session bus above: it is a second, separately
# D-Bus-activated one, lazily started the first time anything asks for it, whose socket lives
# under vyre's own home (~/.cache/at-spi/bus_N, 0700 -- checked live on testbox, 28 Sep: Chrome's
# own accessibility tree was entirely empty until this ran, because the ATK bridge could not
# reach this bus at all; activating it before fluxbox is up did not work either, and this needs a
# short wait too, so it runs here and polls rather than checking once). Force it to start now, as
# vyre, before Chrome ever needs it, then open its whole directory to vyre-bus the same way as the
# session bus's socket above.
setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- \
  env -i HOME="${VYRE_HOME}" USER=vyre LOGNAME=vyre PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
    XAUTHORITY="${VYRE_XAUTH}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS}" DBUS_SESSION_BUS_PID="${DBUS_SESSION_BUS_PID}" \
  dbus-send --session --dest=org.a11y.Bus --type=method_call --print-reply \
    /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null 2>&1 || true
for _ in $(seq 1 25); do
  [ -d "${VYRE_HOME}/.cache/at-spi" ] && break
  sleep 0.2
done
if [ -d "${VYRE_HOME}/.cache/at-spi" ]; then
  as_vyre chgrp -R vyre-bus "${VYRE_HOME}/.cache/at-spi" && as_vyre chmod -R u+rwx,g+rwx,o-rwx "${VYRE_HOME}/.cache/at-spi"
else
  log "AT-SPI's own bus never appeared under ${VYRE_HOME}/.cache; browser will not reach AT-SPI"
fi

# ---- Chrome, as browser, launched here (root) rather than by computerd ------------------------
# The reviewer's root-launcher design (28 Sep): computerd never spawns Chrome and never holds a
# capability at all (its own setpriv call, below, is back to a plain --inh-caps=-all like every
# other process here). Chrome talks CDP over the two FIFOs made early, above, instead of a spawned
# child's own pipe -- computerd opens its own ends (computerd/index.js, CHROME_IN/CHROME_OUT) and
# never touches Chrome's process, uid or a capability of its own.

# Checked once, here, rather than passed to Chrome's argv unvalidated: vyred passes the proxy
# script as a data: URL only when the setting is on and lists a site (config glass.egress,
# core/computers/egress.js); WebRTC is kept off UDP that bypasses the proxy, or a listed site
# could still learn this box's own address from a STUN reply.
PAC="${VYRE_PROXY_PAC:-}"
if [ -n "${PAC}" ] && ! printf '%s' "${PAC}" | grep -Eq '^data:application/x-ns-proxy-autoconfig;base64,[A-Za-z0-9+/]+=*$'; then
  log "VYRE_PROXY_PAC is not a PAC data: URL; refusing to start Chrome without the sites it lists"
  exit 1
fi

chrome_once() {
  # The profile lives on the home volume; a container that was killed (or a Chrome that crashed)
  # leaves its Singleton locks behind, and the next one then refuses to start with "profile in use".
  as_browser sh -c 'for f in SingletonLock SingletonSocket SingletonCookie; do rm -f "$HOME/chromium/$f"; done'
  local pac_args=()
  if [ -n "${PAC}" ]; then pac_args=("--proxy-pac-url=${PAC}" "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"); fi
  # --ambient-caps=-all --bounding-set=-all on top of --inh-caps=-all (the reviewer, 28 Sep): even
  # though nothing here ever raises an ambient capability for this shell to begin with, Chrome is
  # the one process in this container that renders untrusted content, so it gets the belt as well
  # as the braces -- a future regression upstream (an ambient grant added for some other reason)
  # still could not reach it.
  #
  # The FIFOs and the log are group vyre-bus, not world-readable, so the 3<.../4>.../>>... below
  # must be opened by browser's own uid, after setpriv's switch -- as a redirect on the setpriv
  # command line itself, bash would open them as root (this script's own uid) BEFORE setpriv ever
  # runs, and root is not in vyre-bus either (checked live, 28 Sep: "Permission denied"). The inner
  # sh -c, already running as browser by the time it parses its own redirects, is what actually
  # opens them.
  setpriv --reuid=1002 --regid=1002 --init-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
    env -i HOME="${BROWSER_HOME}" USER=browser LOGNAME=browser PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
      XAUTHORITY="${BROWSER_XAUTH}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS}" DBUS_SESSION_BUS_PID="${DBUS_SESSION_BUS_PID}" \
      GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 QT_ACCESSIBILITY=1 \
      CHROME_FIFO_IN="${CHROME_IN}" CHROME_FIFO_OUT="${CHROME_OUT}" CHROME_LOGFILE="${CHROME_LOG}" \
    /bin/sh -c 'exec chromium "$@" 3<"${CHROME_FIFO_IN}" 4>"${CHROME_FIFO_OUT}" >>"${CHROME_LOGFILE}" 2>&1' sh \
      --no-sandbox --test-type --disable-gpu --disable-dev-shm-usage --force-renderer-accessibility \
      --disable-extensions --password-store=basic --remote-debugging-pipe \
      "--user-data-dir=${CHROME_PROFILE}" "--window-size=${SCREEN%x*},${SCREEN#*x}" --start-maximized \
      "${pac_args[@]}" about:blank
}
chrome_loop() {
  while true; do
    chrome_once
    log "chromium exited $?; starting it again in 1 s"
    sleep 1
  done
}
chrome_loop &

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
# AT-SPI-visible tree, for AT-SPI reads only now -- Chrome itself is launched above, not by
# computerd, so computerd needs no capability at all: a plain --inh-caps=-all, the same as every
# other process here (the reviewer's root-launcher design, 28 Sep, replacing the ambient-caps
# grant this line carried before -- a computerd compromise now has nothing to setuid with).
log "starting computerd"
exec setpriv --reuid=1001 --regid=1001 --init-groups --inh-caps=-all -- \
  env -i HOME="${VYRE_HOME}" USER=vyre LOGNAME=vyre PATH="${PATH_SAFE}" LANG="${LANG:-C.UTF-8}" DISPLAY="${DISPLAY}" \
    DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS}" DBUS_SESSION_BUS_PID="${DBUS_SESSION_BUS_PID}" XAUTHORITY="${VYRE_XAUTH}" \
    GTK_MODULES=gail:atk-bridge NO_AT_BRIDGE=0 QT_ACCESSIBILITY=1 \
    COMPUTERD_TOKEN_FILE="${BOOT_FILE}" SCREEN="${SCREEN}" \
    ${COMPUTERD_PORT:+COMPUTERD_PORT="${COMPUTERD_PORT}"} \
    CHROME_IN="${CHROME_IN}" CHROME_OUT="${CHROME_OUT}" COMPUTERD_FS_ROOT="${AGENT_HOME}" \
    AGENT_TOKENS_FILE="${VYRE_HOME}/.agent-tokens" \
    AGENT_DOWNLOADS="${BROWSER_HOME}/downloads" \
    VYRE_FREEZE_FD=9 \
  node /opt/computerd/index.js
