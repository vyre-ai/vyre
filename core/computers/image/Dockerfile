# The agent computer: a desktop, Chrome and a terminal, reached only over the internal Docker
# network (docs/work/computers.md, ADR 0003). Nothing here is published on the host; vyred is the
# only thing that ever dials in, to 5900 (Xvnc, VNC auth) and 7000 (computerd, bearer token).
# Chrome has no debugging port at all: computerd starts it with --remote-debugging-pipe and
# serves CDP only through its own authenticated /cdp route (docs/adr/0012-cdp-proxy.md).
#
# Two users (entrypoint.sh): vyre (1001) runs Xvnc, computerd and Chrome; agent (1000) runs the
# desktop the agent works in. The container starts as root only to switch between them.
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
# tigervnc-tools: vncpasswd, which entrypoint.sh needs to write Xvnc's password file (bookworm
#   moved it out of tigervnc-common; without it the container exits 127 on start).
# fluxbox: a window manager light enough that it does not compete with the agent's work for CPU,
#   and, importantly, one that actually manages windows (AT-SPI and Chrome both assume something
#   is placing and focusing them; a bare Xvnc with no WM leaves every window unmapped at 0,0).
# xterm: the terminal (computers.md: "a desktop, Chrome and a terminal").
# x11-xserver-utils: xhost, so the agent's uid (and only it) may use vyre's X display.
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
      tigervnc-standalone-server tigervnc-common tigervnc-tools \
      fluxbox xterm xdotool x11-utils x11-xserver-utils \
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

# Two fixed users, so a rebuild never changes ownership of an existing volume underneath them:
#   agent (1000): the agent's desktop; its home volume mounts at /home/agent.
#   vyre (1001, also in the agent's group): Xvnc, computerd and Chrome; its own volume mounts at
#     /var/lib/vyre (the Chrome profile, the VNC password), 0700, which the agent cannot open.
# A new named volume copies the image's folder, owner and mode included, on first mount.
RUN groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash -d /home/agent agent \
    && groupadd -g 1001 vyre \
    && useradd -M -u 1001 -g 1001 -G agent -s /usr/sbin/nologin -d /var/lib/vyre vyre \
    && mkdir -p /home/agent/.fluxbox /home/agent/Downloads /var/lib/vyre /opt/computerd \
    && chown -R agent:agent /home/agent \
    && chmod 2775 /home/agent /home/agent/Downloads \
    && chown vyre:vyre /var/lib/vyre && chmod 0700 /var/lib/vyre

# Chromium's own password saving is off by policy: the Vault is the only store (ADR 0005, decision 3).
# No extensions of any kind: one would run in the same page as a password the Vault fills.
# DevTools stay allowed: DeveloperToolsAvailability 2 also refuses CDP attach ("Not allowed"), which
# is how the agent's hands and the Vault fill work; the agent already has CDP through its hands.
RUN mkdir -p /etc/chromium/policies/managed \
    && printf '{"PasswordManagerEnabled": false, "AutofillAddressEnabled": false, "AutofillCreditCardEnabled": false, "ExtensionInstallBlocklist": ["*"]}\n' \
       > /etc/chromium/policies/managed/vyre.json

# root-owned and read-only (the root filesystem is read-only too): neither user can change them.
COPY computerd /opt/computerd
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod -R a+rX,go-w /opt/computerd && chmod 0755 /usr/local/bin/entrypoint.sh /opt/computerd/atspi.py

# Root, for entrypoint.sh to switch users and nothing else: the container gets only CAP_SETUID and
# CAP_SETGID, with no-new-privileges (core/computers/driver/policy.js).
USER root
WORKDIR /home/agent

# Xvnc (VNC auth against VNC_PASSWORD) and computerd (bearer token, including its /cdp proxy).
EXPOSE 5900 7000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
