# The agent computer: a desktop, Chrome and a terminal, reached only over the internal Docker
# network (team/archive/work-journals/computers.md, ADR 0003). Nothing here is published on the host; vyred is the
# only thing that ever dials in, to 5900 (Xvnc, VNC auth) and 7000 (computerd, bearer token).
# Chrome has no debugging port at all: entrypoint.sh's launcher starts it with
# --remote-debugging-pipe, over a pair of named FIFOs computerd opens its own ends of, and
# computerd serves CDP only through its own authenticated /cdp route (docs/adr/0012-cdp-proxy.md).
#
# Three users (entrypoint.sh): vyre (1001) runs Xvnc, the session bus and computerd; browser
# (1002) runs Chrome only, launched by entrypoint.sh itself (root), never by computerd -- so a
# Chrome exploit lands in a uid with no access to /var/lib/vyre's secrets (.boot, the VNC
# password) or to vyre's own X cookie, and a computerd compromise has no capability to become
# browser, vyre or root with (see docs/design/agent-browsers.md, "Chrome gets its own uid", and
# entrypoint.sh's chrome_once/chrome_loop for how it is actually launched). agent (1000) runs the
# desktop the agent works in. The container starts as root only to switch between them.
#
# VALIDATED (30 Sep, on the test server, scripts/computers-proof): built and run for real; the uid split holds
# (isolation.test.js 13 of 13 in the running container: exec env and .boot unreadable by the agent, Chrome's uid cannot
# open .boot, the VNC password or the X cookie, no capabilities). Downloads land in /var/lib/vyre/browser/downloads
# (owned by the browser uid, readable by the agent), by design.

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

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

# Three fixed users, so a rebuild never changes ownership of an existing volume underneath them:
#   agent (1000): the agent's desktop; its home volume mounts at /home/agent.
#   vyre (1001, also in the agent's group): Xvnc, the session bus and computerd; its own volume
#     mounts at /var/lib/vyre (the VNC password, the boot secrets, its own X cookie), 0711 --
#     traversable (so browser can reach the one subdirectory it owns) but not listable or
#     readable by anyone else; every file and subdirectory vyre itself owns under it stays 0700/
#     0600, which even the traverse bit does not open.
#   browser (1002, its own group vyre-bus shared with vyre only): Chrome, and nothing else. Its
#     profile and downloads live under /var/lib/vyre/browser, a subdirectory of vyre's volume that
#     browser owns outright (0750, group agent, so the real agent can read what Chrome downloads
#     the same way it always could) -- vyre cannot re-chown an existing volume's directories at
#     runtime (no CAP_CHOWN), so this subtree is pre-made here, at build time, with its final
#     ownership already on it: a fresh volume copies it as-is on first mount (see the Dockerfile's
#     own note below), and an old volume from before this split keeps its old vyre-owned
#     `chromium/` folder untouched -- entrypoint.sh migrates out of it once, the same way it
#     already migrates out of the agent's original `.chromium/` (glass-live's Rollout note).
#   vyre-bus (a group, not a login): membership, not a uid, is what lets browser reach vyre's own
#     D-Bus session bus for AT-SPI (chgrp'd there by vyre itself at start, since an owner may hand
#     a file to any group they already belong to without CAP_CHOWN) while /var/lib/vyre's secrets
#     stay behind file modes group membership can never open.
# A new named volume copies the image's folder, owner and mode included, on first mount.
RUN groupadd -g 1000 agent \
    && useradd -m -u 1000 -g 1000 -s /bin/bash -d /home/agent agent \
    && groupadd -g 1001 vyre \
    && groupadd -g 1003 vyre-bus \
    && useradd -M -u 1001 -g 1001 -G agent,vyre-bus -s /usr/sbin/nologin -d /var/lib/vyre vyre \
    && groupadd -g 1002 browser \
    && useradd -M -u 1002 -g 1002 -G vyre-bus -s /usr/sbin/nologin -d /var/lib/vyre/browser browser \
    && mkdir -p /home/agent/.fluxbox /home/agent/Downloads /var/lib/vyre /opt/computerd \
    && chown -R agent:agent /home/agent \
    && chmod 2775 /home/agent /home/agent/Downloads \
    && chown vyre:vyre /var/lib/vyre && chmod 0711 /var/lib/vyre \
    && mkdir -p /var/lib/vyre/browser/chromium /var/lib/vyre/browser/downloads \
    && chown browser:agent /var/lib/vyre/browser && chmod 0750 /var/lib/vyre/browser \
    && chown browser:browser /var/lib/vyre/browser/chromium && chmod 0700 /var/lib/vyre/browser/chromium \
    && chown browser:agent /var/lib/vyre/browser/downloads && chmod 2750 /var/lib/vyre/browser/downloads

# Chromium's own password saving is off by policy: the Vault is the only store (ADR 0005, decision 3).
# No extensions of any kind: one would run in the same page as a password the Vault fills.
# DevTools stay allowed: DeveloperToolsAvailability 2 also refuses CDP attach ("Not allowed"), which
# is how the agent's hands and the Vault fill work; the agent already has CDP through its hands.
# Chrome runs as browser (1002), its own uid: no page may open file:// (browser's own profile,
# vyre's secrets and X cookie -- a different uid either way, and unreadable to browser even by
# path), chrome:// or devtools:// (the browser's own pages) or an extension's, however the
# navigation starts; computerd refuses the same at the CDP call (cdpmux.js), which is the real
# enforcement for downloads too (cdpmux.js's `this.downloads`, not this static policy) -- kept
# here in sync so a Chrome that ever ignored the CDP check still lands in the same folder, not a
# guess. The new tab is blank (chrome://newtab is blocked with the rest).
RUN mkdir -p /etc/chromium/policies/managed \
    && printf '%s\n' '{"PasswordManagerEnabled": false, "AutofillAddressEnabled": false, "AutofillCreditCardEnabled": false,' \
       ' "ExtensionInstallBlocklist": ["*"],' \
       ' "URLBlocklist": ["file://*", "chrome://*", "devtools://*", "chrome-extension://*", "chrome-untrusted://*", "view-source:*"],' \
       ' "DownloadDirectory": "/var/lib/vyre/browser/downloads", "PromptForDownloadLocation": false,' \
       ' "NewTabPageLocation": "about:blank", "HomepageLocation": "about:blank", "HomepageIsNewTabPage": false}' \
       > /etc/chromium/policies/managed/vyre.json \
    && python3 -c 'import json; json.load(open("/etc/chromium/policies/managed/vyre.json"))'

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
