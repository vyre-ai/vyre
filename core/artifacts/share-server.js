// @ts-check
// The public share server: the one thing that answers a public artifact link. A separate process
// that imports nothing from Vyre and holds no socket, token or key of vyred's. It reads one folder
// of published snapshots (<data>/public/<sha256 of the link token>/{index.html,meta.json}) and
// nothing else, and listens on loopback only. Tailscale Funnel proxies https://<node>:8443/s/ to
// it (tailnet owns turning Funnel on; plans/artifacts.md 3.6, AR6). vyred starts it under Node's
// permission model with read and write limited to that folder; on a Linux box the image also runs
// it as its own uid (integrator).
//
// It answers GET and HEAD on /s/<token> only. An unknown or malformed token is a bare 404, a
// stopped or expired share a 410 (and an expired one is deleted), everything else 404 or 405.
// Nothing it sends names the box, the project, the agent or the thread.
//
// Usage: node share-server.js --dir <public folder> [--port 7311]   ("listening <port>" on stdout)

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (/** @type {string} */ k, /** @type {string} */ d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = path.resolve(opt("--dir", ""));
const PORT = Number(opt("--port", "7311"));
if (!opt("--dir", "")) { process.stderr.write("share-server: --dir is required\n"); process.exit(2); }

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const HEADERS_404 = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

// A small fixed budget: 60 requests a minute per link, 600 in all. Behind Funnel every request
// comes from Tailscale's own relays, so a per-address limit would mean nothing.
const budget = { all: 0, per: /** @type {Map<string, number>} */ (new Map()) };
setInterval(() => { budget.all = 0; budget.per.clear(); }, 60_000).unref();

/** @param {http.ServerResponse} res @param {number} code @param {string} text */
const plain = (res, code, text) => { res.writeHead(code, HEADERS_404); res.end(text); };

/** @param {string} hash */
const views = hash => {
  const f = path.join(DIR, hash, "views");
  try { const n = Number(fs.readFileSync(f, "utf8")) || 0; fs.writeFileSync(f, String(n + 1)); } catch { try { fs.writeFileSync(f, "1"); } catch {} }
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://share.invalid");
  const m = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return plain(res, 404, "Not found");
  if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); return plain(res, 405, "GET only"); }
  const token = m[1];
  if (!TOKEN.test(token)) return plain(res, 404, "Not found");
  if (++budget.all > 600) return plain(res, 429, "Too many requests, try again in a minute");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const n = (budget.per.get(hash) || 0) + 1;
  budget.per.set(hash, n);
  if (n > 60) return plain(res, 429, "Too many requests, try again in a minute");
  const dir = path.join(DIR, hash);
  /** @type {{ expires_at?: number|null, headers?: Record<string,string> }} */
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch { return plain(res, fs.existsSync(path.join(DIR, `${hash}.gone`)) ? 410 : 404, fs.existsSync(path.join(DIR, `${hash}.gone`)) ? "This link was turned off" : "Not found"); }
  if (meta.expires_at && Date.now() > meta.expires_at) {
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(path.join(DIR, `${hash}.gone`), ""); } catch {}
    return plain(res, 410, "This link has expired");
  }
  let body;
  try { body = fs.readFileSync(path.join(dir, "index.html")); } catch { return plain(res, 404, "Not found"); }
  const headers = meta.headers && typeof meta.headers === "object" ? meta.headers : {};
  res.writeHead(200, { ...headers, "content-length": body.length });
  if (req.method === "HEAD") return res.end();
  views(hash);
  res.end(body);
});
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.listen(PORT, "127.0.0.1", () => {
  const a = server.address();
  process.stdout.write(`listening ${a && typeof a === "object" ? a.port : PORT}\n`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
