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

# The node image ships user `node` as uid 1000. Rename it to vyre, and give it /work.
RUN usermod -l vyre -d /home/vyre -m node \
 && groupmod -n vyre node \
 && mkdir -p /work \
 && chown 1000:1000 /work

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

# tini is the init (it reaps, and it keeps the dtach terminals once vyred is gone), and the loop
# restarts vyred inside the container, so a vyred restart keeps every terminal (ADR 0029, R4).
# A deploy recreates the container, and its terminals end; the Deck says so (term.closed).
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/vyre/core/daemon/loop.sh"]
