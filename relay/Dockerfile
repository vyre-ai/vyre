# The self-hosted Vyre relay and name directory: one small container, no dependencies. Build context is the repo root:
#   docker build -f relay/Dockerfile -t vyre-relay .
# Plain HTTP and WebSocket on 8080 (relay) and 8081 (directory); terminate TLS in front of it (relay/README.md).
# The base is pinned by digest, as in box/Dockerfile (node:22-bookworm-slim); test/box-init.test.js fails an unpinned FROM.
FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

LABEL org.opencontainers.image.source="https://github.com/vyre-ai/vyre" \
      org.opencontainers.image.title="vyre-relay"

WORKDIR /app
# Only what the relay and the directory import. package.json says "type": "module".
COPY package.json ./
COPY lib ./lib
COPY core/relay ./core/relay
COPY names/worker ./names/worker
COPY kernel/identity ./kernel/identity
COPY relay/node ./relay/node
COPY relay/worker/fake-cf.js ./relay/worker/fake-cf.js

# One state file (the directory's claims) lives in /data; the relay keeps nothing on disk. The node user owns /data and nothing else.
RUN mkdir /data && chown node:node /data
VOLUME /data
USER node
ENV VYRE_STATE_DIR=/data NODE_ENV=production
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VYRE_RELAY_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "relay/node/main.js"]
