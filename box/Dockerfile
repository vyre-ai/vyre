# The Vyre box image. Build context is the repo root:
#   docker build -f box/Dockerfile .
# Normally built through box/compose.build.yml, or pulled as ghcr.io/vyre-ai/vyre.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

LABEL run.vyre="1" \
      org.opencontainers.image.source="https://github.com/vyre-ai/vyre"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tar openssl curl procps dtach tini \
 && rm -rf /var/lib/apt/lists/*

# The tailscale CLI only. tailscaled runs in the tailscale container; the CLI talks to it
# through the shared socket at /var/run/tailscale/tailscaled.sock.
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# The Claude Agent SDK that Vyre-owned sessions run on (ADR 0030), with the Claude Code it bundles
# (its platform optional package, about 230 MB, so no --omit=optional). The version is the one
# pinned in core/sessions/sdk.js; bumping it there rebuilds this layer. Installed here rather than
# on first use so a box never downloads it at runtime. VYRE_SESSIONS_SDK_DIR (below) points
# sdkDir() at it. Each session is spawned as `tini -s -- claude ...` (/usr/bin/tini, above).
COPY core/sessions/sdk.js /tmp/vyre-sdk.mjs
RUN mkdir -p /opt/vyre-sessions-sdk \
 && cd /opt/vyre-sessions-sdk \
 && VERSION=$(node --input-type=module -e "import('/tmp/vyre-sdk.mjs').then(m => process.stdout.write(m.PACKAGE + '@' + m.VERSION))") \
 && printf '{"name":"vyre-sessions-sdk","private":true,"type":"module","description":"The Claude Agent SDK Vyre runs its sessions on, installed in the image."}\n' > package.json \
 && npm install --no-audit --no-fund --omit=dev --no-package-lock --loglevel=error "$VERSION" \
 && npm cache clean --force \
 && rm /tmp/vyre-sdk.mjs \
 && chmod -R a+rX /opt/vyre-sessions-sdk

# The node image ships user `node` as uid 1000. Rename it to vyre, and give it /work.
RUN usermod -l vyre -d /home/vyre -m node \
 && groupmod -n vyre node \
 && mkdir -p /work \
 && chown 1000:1000 /work
# The split (ADR 0032): Vyre-owned Claude sessions run as vyre-agent, which cannot open vyred's
# socket or read /home/vyre. Projects in /work are shared through the vyre-work group.
RUN groupadd -g 1002 vyre-work \
 && groupadd -g 1001 vyre-agent \
 && useradd -u 1001 -g 1001 -G vyre-work -m -d /home/vyre-agent -s /bin/sh vyre-agent \
 && usermod -aG vyre-work vyre \
 && chown 1000:1002 /work && chmod 2775 /work \
 && chmod 700 /home/vyre \
 && chown 1001:1002 /home/vyre-agent && chmod 2750 /home/vyre-agent \
 && mkdir -p /run/vyre && chown 0:1000 /run/vyre && chmod 2750 /run/vyre \
 && mkdir -p /run/vyre-threads && chown 1000:1002 /run/vyre-threads && chmod 2710 /run/vyre-threads

# Everything .dockerignore lets through: package files, bin, core, harness, docs, LICENSE,
# README.md, and deck, modules and local when they exist.
WORKDIR /opt/vyre
COPY . /opt/vyre
# A checkout has package-lock.json; the release tarball (npm pack) never does.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi \
 && npm cache clean --force \
 && ln -s /opt/vyre/bin/vyre /usr/local/bin/vyre

# node:sqlite is still flagged experimental in Node 22; the warning is noise in every log line.
ENV VYRE_HOME=/home/vyre/.vyre \
    VYRE_SUPERVISOR=docker \
    VYRE_SESSIONS_SDK_DIR=/opt/vyre-sessions-sdk \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

USER vyre
WORKDIR /home/vyre

# tini is the init (PID 1: it reaps, and it keeps the dtach terminals once vyred is gone). As
# root (compose), the spawner comes next (core/spawner, ADR 0032): it runs the loop, which
# restarts vyred, as uid vyre, and starts Vyre-owned sessions as vyre-agent. As vyre (a plain
# docker run), the spawner runs the loop itself. A vyred restart keeps every terminal (ADR 0029,
# R4); a deploy recreates the container, and its terminals end; the Deck says so (term.closed).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/vyre/core/spawner/main.js"]
