#!/usr/bin/env node
// A local stand-in for the names directory (names/worker), for walks and tests that need identities and spaces without touching vyre.run or any real name.
// It serves the Worker's REAL code and routes (names/worker/index.js: claim, resolve, append, update, alias, release, the box names) over plain HTTP on a local port,
// on the fake Workers runtime the Worker's own tests use (relay/worker/fake-cf.js): in-memory Durable Object storage, a fake DNS zone (nothing is published anywhere),
// a fake DNS-over-HTTPS (own-domain aliases read their TXT from a file you control, below), and a request clock that is the real one. State lives as long as this process.
//
//   node scripts/standin-directory.mjs [--port 8787] [--host 127.0.0.1] [--zone vyre.test] [--txt-file ./txt.json]
//
// A box points at it with ONE config line (the home's config.json, or `vyre config set`):  "names": { "directory": "http://127.0.0.1:8787" }
// The client refuses to talk to a non-loopback http directory from a test process, so for a walk on two machines run this on the box that hosts the stand-ins and give the
// other machine its address with the same one line. Do NOT point a walk at the real directory: a test claim there is a real claim.
//
// --txt-file: a JSON object { "_vyre-id.alex.example.com": ["vyre-id=2;name=..."] } read on every alias check, so a walk can publish the alias proof without real DNS.
import http from "node:http";
import fs from "node:fs";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import worker, * as W from "../names/worker/index.js";

const arg = (/** @type {string} */ name, /** @type {string} */ fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const PORT = Number(arg("port", "8787")), HOST = arg("host", "127.0.0.1"), ZONE = arg("zone", "vyre.test"), TXT = arg("txt-file", "");
const dns = fakeDns();
const rt = createRuntime({
  worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
  env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, ZONE, ORIGIN: `http://${HOST}:${PORT}`,
    RESOLVE_TXT: async (/** @type {string} */ name) => { try { return (JSON.parse(fs.readFileSync(TXT, "utf8"))[name] || []).map(String); } catch { return []; } } },
});

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  // The Worker rate-limits by the address Cloudflare reports; here it is the socket's own.
  headers.set("cf-connecting-ip", req.socket.remoteAddress || "127.0.0.1");
  try {
    const r = await worker.fetch(new Request(`http://${HOST}:${PORT}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(String(req.method)) || !body.length ? undefined : body }), rt.env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "standin_failed", message: String(/** @type {Error} */ (e).message) } }));
  }
});
server.listen(PORT, HOST, () => console.log(`stand-in names directory on http://${HOST}:${PORT} (zone ${ZONE}, in memory, nothing real is touched)`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
