// J1's stand-ins, on a CI runner only (nothing here ever reaches vyre.run):
//   - a real relay (relay/node/server.js), on all interfaces so the box's container can reach it;
//   - a static server for the staged setup page, the box files and `/i` (the install script the
//     page's line downloads), all on loopback.
// Prints one JSON line {relay, site, hostIp} and keeps running until it is killed.
//
//   node scripts/matrix/j1-services.mjs <staged-site-dir> <box-dir>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRelay } from "../../relay/node/server.js";
import worker, * as Names from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";

if (!process.env.CI) { console.error("j1-services: runs on a CI runner only (CI is unset)"); process.exit(2); }
const [siteDir, boxDir] = process.argv.slice(2).map(d => path.resolve(d));
const hostIp = Object.values(os.networkInterfaces()).flat().find(n => n && n.family === "IPv4" && !n.internal)?.address || "127.0.0.1";

const relay = createRelay({});
const relayUrl = await relay.listen(0, "0.0.0.0");
const relayPort = new URL(relayUrl.replace(/^ws/, "http")).port;

// The name directory: the real Worker code (names/worker) over the test runtime and a fake Cloudflare
// DNS, behind a plain HTTP server so a box can reach it. The records it writes stay in memory here.
const dns = fakeDns();
const rt = createRuntime({ worker, Class: Names.Directory, classes: { DIRECTORY: Names.Directory },
  env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, ZONE: "vyre.run" } });
const namesSrv = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  headers.set("cf-connecting-ip", req.socket.remoteAddress?.replace("::ffff:", "") || "203.0.113.7");
  try {
    const r = await worker.fetch(new Request("https://names.vyre.run" + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : body }), rt.env);
    res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise(r => namesSrv.listen(0, "0.0.0.0", r));
const namesPort = /** @type {any} */ (namesSrv.address()).port;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain" };
const site = http.createServer((req, res) => {
  const u = new URL(req.url || "/", "http://x");
  let p = decodeURIComponent(u.pathname);
  let file;
  if (p === "/i") file = path.join(siteDir, "install.sh");
  else if (p.startsWith("/box/")) file = path.join(boxDir, p.slice(5));
  else { if (p.endsWith("/")) p += "index.html"; file = path.join(siteDir, p); }
  if (!path.resolve(file).startsWith(siteDir) && !path.resolve(file).startsWith(boxDir)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(buf);
  });
});
await new Promise(r => site.listen(0, "0.0.0.0", r));
const sitePort = /** @type {any} */ (site.address()).port;
console.log(JSON.stringify({ relay: `ws://127.0.0.1:${relayPort}`, relayForBox: `http://${hostIp}:${relayPort}`, relayForBoxWs: `ws://${hostIp}:${relayPort}`, site: `http://127.0.0.1:${sitePort}`, hostIp, namesForBox: `http://${hostIp}:${namesPort}` }));
setInterval(() => {}, 1 << 30);
