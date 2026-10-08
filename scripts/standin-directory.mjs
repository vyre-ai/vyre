#!/usr/bin/env node
// A local stand-in for the names directory (names/worker), for walks and tests that need identities and spaces without touching vyre.run or any real name.
// It serves the Worker's REAL code and routes (names/worker/index.js: reserve, finalize, claim (spaces), resolve, append, update, alias, release, a space's servers) over plain HTTP on a local port,
// on the fake Workers runtime the Worker's own tests use (relay/worker/fake-cf.js): in-memory Durable Object storage, a fake DNS zone (nothing is published anywhere),
// a fake DNS-over-HTTPS (own-domain aliases read their TXT from a file you control, below), and a request clock that is the real one. State lives as long as this process.
//
//   node scripts/standin-directory.mjs [--port 8787] [--host 127.0.0.1] [--zone vyre.test] [--txt-file ./txt.json] [--app-origins "https://app.vyre.run,http://localhost:5173"] [--claims-per-ip 5] [--state ./dir-state.bin] [--restore-time]
//
// A box points at it with ONE config line (the home's config.json, or `vyre config set`):  "names": { "directory": "http://127.0.0.1:8787" }
// The client refuses to talk to a non-loopback http directory from a test process, so for a walk on two machines run this on the box that hosts the stand-ins and give the
// other machine its address with the same one line. Do NOT point a walk at the real directory: a test claim there is a real claim.
//
// --state: the directory's storage is kept in this file (written a moment after every change, read at start), so a restart keeps every claim. The fake DNS zone is not kept.
// --restore-time: a claim whose signed record is older than the clock is judged at the record's own time, so an identity that lost its claim (a directory restarted without --state) can be
// published again from the chain it holds (the claimant builds the record with its dir clock set to the chain's last op time). Test directories only.
// --txt-file: a JSON object { "_vyre-id.alex.example.com": ["vyre-id=2;name=..."] } read on every alias check, so a walk can publish the alias proof without real DNS.
import http from "node:http";
import fs from "node:fs";
import v8 from "node:v8";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import worker, * as W from "../names/worker/index.js";

const arg = (/** @type {string} */ name, /** @type {string} */ fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const PORT = Number(arg("port", "8787")), HOST = arg("host", "127.0.0.1"), ZONE = arg("zone", "vyre.test"), TXT = arg("txt-file", "");
// The Vyre app's browser origins allowed to claim and update identities (the identity's own signature authenticates; CORS for resolve is open to any origin, as in the real worker).
// Default: the real app, and the dev servers the web app uses on a test box. `--app-origins "https://a.example,http://localhost:5173"` replaces them.
const APP_ORIGINS = arg("app-origins", "https://app.vyre.run,http://localhost:5173,http://127.0.0.1:5173,http://localhost:8081,http://localhost:3000");
// The daily claim limit per address (the live directory's is 5). A test box that walks many installs from one address raises it here: `--claims-per-ip 50`.
const CLAIMS_PER_IP_PER_DAY = arg("claims-per-ip", "5");
const STATE = arg("state", ""), RESTORE_TIME = process.argv.includes("--restore-time");
let replay = false;
// While a chain older than a minute is being published again, the Worker judges it as a copy, not as a live op (`live: false`): nothing else about the claim is relaxed.
const idLive = /** @type {any} */ (W.Directory.prototype).idLive;
/** @type {any} */ (W.Directory.prototype).idLive = function () { const c = idLive.call(this); return replay ? { ...c, live: false } : c; };
const dns = fakeDns();
const rt = createRuntime({
  worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
  env: { APP_ORIGINS, CLAIMS_PER_IP_PER_DAY, CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, ZONE, ORIGIN: `http://${HOST}:${PORT}`,
    RESOLVE_TXT: async (/** @type {string} */ name) => { try { return (JSON.parse(fs.readFileSync(TXT, "utf8"))[name] || []).map(String); } catch { return []; } } },
});

// Keep the directory's one Durable Object's storage in --state: read it now, write it (atomically) a moment after each change.
if (STATE) {
  const storage = rt.object("v1", "DIRECTORY").ctx.storage;
  try { for (const [k, v] of v8.deserialize(fs.readFileSync(STATE))) storage.map.set(k, v); console.log(`restored ${storage.map.size} keys from ${STATE}`); } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") console.log(`state file not read: ${/** @type {Error} */ (e).message}`); }
  /** @type {NodeJS.Timeout | null} */ let timer = null;
  const save = () => { if (timer) return; timer = setTimeout(() => { timer = null; try { fs.writeFileSync(`${STATE}.tmp`, v8.serialize([...storage.map])); fs.renameSync(`${STATE}.tmp`, STATE); } catch (e) { console.log(`state not written: ${/** @type {Error} */ (e).message}`); } }, 300); };
  for (const m of ["put", "delete", "deleteAll"]) { const orig = storage[m].bind(storage); storage[m] = async (/** @type {any[]} */ ...a) => { const r = await orig(...a); save(); return r; }; }
}

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  // The Worker rate-limits by the address Cloudflare reports; here it is the socket's own.
  headers.set("cf-connecting-ip", req.socket.remoteAddress || "127.0.0.1");
  let restoring = false;
  if (RESTORE_TIME && req.method === "POST" && /^\/v1\/ids\/(claim|finalize)/.test(String(req.url))) {
    try { const ops = JSON.parse(body.toString("utf8")).ops; const last = Number(ops[ops.length - 1].ts); if (Number.isFinite(last) && last < Date.now() - 60_000) { restoring = true; replay = true; } } catch { /* an ordinary claim */ }
  }
  try {
    const r = await worker.fetch(new Request(`http://${HOST}:${PORT}${req.url}`, { method: req.method, headers, body: ["GET", "HEAD"].includes(String(req.method)) || !body.length ? undefined : body }), rt.env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    if (restoring) replay = false;
  } catch (e) {
    if (restoring) replay = false;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "standin_failed", message: String(/** @type {Error} */ (e).message) } }));
  }
});
server.listen(PORT, HOST, () => console.log(`stand-in names directory on http://${HOST}:${PORT} (zone ${ZONE}, in memory, nothing real is touched)`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
