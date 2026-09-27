# The Vyre box image. Build context is the repo root:
#   docker build -f box/Dockerfile .
# Normally built through box/compose.build.yml, or pulled as ghcr.io/vyre-ai/vyre.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest

LABEL run.vyre="1" \
      org.opencontainers.image.source="https://github.com/vyre-ai/vyre"

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tar openssl curl procps tini \
 && rm -rf /var/lib/apt/lists/*

# The tailscale CLI only. tailscaled runs in the tailscale container; the CLI talks to it
# through the shared socket at /var/run/tailscale/tailscaled.sock.
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale /usr/local/bin/tailscale

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

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
 && mkdir -p /run/vyre && chown 0:1000 /run/vyre && chmod 2750 /run/vyre

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
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

USER vyre
WORKDIR /home/vyre

# As root (compose), this is the spawner, which runs vyred as vyre; as vyre, vyred itself.
CMD ["node", "/opt/vyre/core/spawner/main.js"]
