# The agent computer: a desktop, Chrome and a terminal, reached only over the internal Docker
# network (docs/work/computers.md, ADR 0003). Nothing here is published on the host; vyred is the
# only thing that ever dials in, to 5900 (Xvnc, VNC auth) and 7000 (computerd, bearer token).
# Chrome's own debugging port stays on 127.0.0.1 inside the container and is never a published
# port of its own: computerd proxies it out authenticated (docs/adr/0005-cdp-proxy.md).
#
# UNVALIDATED: built by inspection, never `docker build`'d (no Linux Docker host in this session).
# See docs/work/computers.md's "Needs from others" and the report to the lead for what to check
# once the box is up.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:1 \
    HOME=/home/agent \
    LANG=C.UTF-8

# tigervnc-standalone-server: Xvnc, the X server and VNC server in one process (ADR 0003).
# fluxbox: a window manager light enough that it does not compete with the agent's work for CPU,
#   and, importantly, one that actually manages windows (AT-SPI and Chrome both assume something
#   is placing and focusing them; a bare Xvnc with no WM leaves every window unmapped at 0,0).
# xterm: the terminal (computers.md: "a desktop, Chrome and a terminal").
# xdotool: /input (click, key, type).
# at-spi2-core, dbus-x11: the accessibility bus computerd's AT-SPI side talks to. dbus-x11 for
#   dbus-launch, since there is no systemd/session manager in a container to start one.
# python3, python3-gi, gir1.2-atspi-2.0: AT-SPI's usable binding is Python (see
#   modules/hands-desktop/snapshot.js's header comment and bin/desktop.cjs on the Mac side, which
#   made the same call for the macOS/AT-SPI hands). Modern Debian ships the GObject-introspection
#   binding (gi.repository.Atspi) rather than the older standalone python3-pyatspi package, which
#   is gone from bookworm; computerd/atspi.py is written against Atspi, not pyatspi.
# chromium: Debian's package, to avoid Google Chrome's own package/licensing surface. Its binary
#   is `chromium`.
# imagemagick: `import` for /screenshot (reads straight off the X display, no extra X extension).
# nodejs: computerd's HTTP server. Bookworm's apt nodejs is too old for this repo's
#   `engines.node: ">=22.5"`, so it is installed from the NodeSource setup script below instead of
#   the Debian package.
# tini: PID 1. A container gets SIGTERM on `docker stop`; nothing here else reaps zombies
#   (xdotool, import and the AT-SPI helper are all short-lived children of computerd).
# fonts-liberation, fonts-noto-color-emoji: Chromium and everything else needs *some* fonts or
#   every page renders tofu.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
      tigervnc-standalone-server tigervnc-common \
      fluxbox xterm xdotool x11-utils \
      at-spi2-core dbus-x11 \
      python3 python3-gi gir1.2-atspi-2.0 \
      chromium \
      imagemagick \
      tini \
      fonts-liberation fonts-noto-color-emoji \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# A non-root user: the container's home volume mounts at /home/agent (core/computers/pool.js,
# core/computers/driver/index.js's CreateSpec.volume). uid/gid fixed rather than left to
# useradd's default, so a rebuild never changes ownership of an existing home volume underneath it.
RUN groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash -d /home/agent agent \
    && mkdir -p /home/agent/.vnc /home/agent/.fluxbox /opt/computerd \
    && chown -R agent:agent /home/agent /opt/computerd

COPY --chown=agent:agent computerd /opt/computerd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /opt/computerd/atspi.py

USER agent
WORKDIR /home/agent

# Xvnc (VNC auth against VNC_PASSWORD) and computerd (bearer token, including its /cdp proxy).
EXPOSE 5900 7000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
