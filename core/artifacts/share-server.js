// @ts-check
// The public share server: the one thing that answers a public artifact link. A separate process
// that imports nothing from Vyre and holds no socket, token or key of vyred's. It reads one folder
// of published snapshots (<data>/public/<sha256 of the link token>/{index.html,meta.json}) and
// nothing else, and listens on loopback only. Whatever carries public links to this home (the relay, once it does: team/BACKLOG.md "public ingress") proxies /s/ to
// it (plans/artifacts.md 3.6, AR6). The box image runs it under its
// OWN user, never vyred's (reviewer-2 H2): given --not-uid <vyred's uid> it refuses to start as that
// user, and it never runs as root. Run it under Node's permission model too, with read and write
// limited to that folder. When it listens it writes <dir>/.server.json {pid, uid, port}; vyred turns
// public links on only after checking that process's real uid. While <dir>/.off exists (public
// links turned off) every link answers 404.
//
// It answers GET and HEAD on /s/<token> only. An unknown or malformed token is a bare 404, a
// stopped or expired share a 410 (and an expired one is deleted), everything else 404 or 405.
// Nothing it sends names the box, the project, the agent or the thread.
//
// Usage: node share-server.js --dir <public folder> --not-uid <vyred uid> [--port 7311]
//        ("listening <port>" on stdout)

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (/** @type {string} */ k, /** @type {string} */ d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DIR = path.resolve(opt("--dir", ""));
const PORT = Number(opt("--port", "7311"));
if (!opt("--dir", "")) { process.stderr.write("share-server: --dir is required\n"); process.exit(2); }
const NOT_UID = Number(opt("--not-uid", "-1"));
const ME = typeof process.getuid === "function" ? process.getuid() : -1;
if (ME === 0 || ME === NOT_UID || NOT_UID < 0) {
  process.stderr.write(`share-server: refusing to run as ${ME === 0 ? "root" : NOT_UID < 0 ? "an unchecked user (pass --not-uid <vyred's uid>)" : "Vyre's own user"}\n`);
  process.exit(3);
}

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;
const HEADERS_404 = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

// A small fixed budget: 60 requests a minute per link, 600 in all. Behind a proxy every request
// comes from the proxy's address, so a per-address limit would mean nothing.
const budget = { all: 0, per: /** @type {Map<string, number>} */ (new Map()) };
setInterval(() => { budget.all = 0; budget.per.clear(); }, 60_000).unref();

/** @param {http.ServerResponse} res @param {number} code @param {string} text */
const plain = (res, code, text) => { res.writeHead(code, HEADERS_404); res.end(text); };

/** @param {string} hash */
const views = hash => {
  const f = path.join(DIR, hash, "views");
  try { const n = Number(fs.readFileSync(f, "utf8")) || 0; fs.writeFileSync(f, String(n + 1)); } catch { try { fs.writeFileSync(f, "1"); } catch {} }
};

// Published media: one file named media.<ext>. The type comes from the extension here, never from meta.json, and the bytes
// were checked against it when they were kept.
const MEDIA_TYPES = /** @type {Record<string,string>} */ ({ png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4" });
/** @param {string|undefined} h @param {number} size @returns {{ start: number, end: number } | null | "bad"} */
function range(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  let start, end;
  if (m[1] === "") { const n = Number(m[2]); if (!n) return "bad"; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1); }
  return !Number.isFinite(start) || start >= size || end < start ? "bad" : { start, end };
}
/** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} hash @param {string} dir @param {{ file?: string }} media */
function serveMedia(req, res, hash, dir, media) {
  const m = /^media\.(png|jpeg|webp|gif|mp4|webm|mp3|wav|ogg|m4a)$/.exec(String(media && media.file));
  if (!m) return plain(res, 404, "Not found");
  const file = path.join(dir, m[0]);
  let size;
  try { const st = fs.lstatSync(file); if (!st.isFile()) return plain(res, 404, "Not found"); size = st.size; } catch { return plain(res, 404, "Not found"); }
  const r = range(req.headers.range, size);
  const head = { "content-type": MEDIA_TYPES[m[1]], "x-content-type-options": "nosniff", "accept-ranges": "bytes", "content-security-policy": "sandbox; default-src 'none'", "content-disposition": "inline",
    "referrer-policy": "no-referrer", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "x-frame-options": "DENY", "cross-origin-resource-policy": "cross-origin" }; // public by design: a link is put in landing pages and emails
  if (r === "bad") { res.writeHead(416, { "content-range": `bytes */${size}`, "cache-control": "no-store" }); return res.end(); }
  const [start, end] = r ? [r.start, r.end] : [0, size - 1];
  res.writeHead(r ? 206 : 200, { ...head, "content-length": end - start + 1, ...(r ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
  if (req.method === "HEAD") return res.end();
  if (!r || start === 0) views(hash);
  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://share.invalid");
  const m = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return plain(res, 404, "Not found");
  if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("allow", "GET, HEAD"); return plain(res, 405, "GET only"); }
  const token = m[1];
  if (!TOKEN.test(token) || fs.existsSync(path.join(DIR, ".off"))) return plain(res, 404, "Not found");
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
  if (meta.media) return serveMedia(req, res, hash, dir, meta.media);
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
const RECORD = path.join(DIR, ".server.json");
server.listen(PORT, "127.0.0.1", () => {
  const a = server.address();
  const port = a && typeof a === "object" ? a.port : PORT;
  try { fs.writeFileSync(RECORD, JSON.stringify({ pid: process.pid, uid: ME, port }), { mode: 0o644 }); } catch (e) { process.stderr.write(`share-server: can't write ${RECORD}: ${/** @type {Error} */ (e).message}\n`); }
  process.stdout.write(`listening ${port}\n`);
});
const stop = () => { try { if (JSON.parse(fs.readFileSync(RECORD, "utf8")).pid === process.pid) fs.rmSync(RECORD, { force: true }); } catch {} server.close(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
