#!/usr/bin/env node
// standin-relay: the 0.3 relay (relay/node/server.js, the same protocol as the Cloudflare Worker, including the typed-code rendezvous) for a test box,
// so the 0.3 end-to-end walk runs without a live deploy of relay.vyre.run. Plain ws/http on one port; test boxes only.
//   node scripts/standin-relay.mjs [port] [host]        defaults 8787 and 0.0.0.0
// Point a box at it with `relay.url` in its config: { "relay": { "enabled": true, "url": "ws://<this host>:8787" } }.
import { createRelay } from "../relay/node/server.js";

const port = Number(process.argv[2] || process.env.PORT || 8787), host = process.argv[3] || process.env.HOST || "0.0.0.0";
const relay = createRelay({});
const base = await relay.listen(port, host);
console.log(`standin-relay: listening on ${base} (health: curl ${base.replace(/^ws/, "http")}/health)`);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, async () => { await relay.close(); process.exit(0); });
