// kernel/storage/bridge.js: a drive that only another device can reach (the user's own example: a drive plugged into the office network, shared with the
// space). A device on that network, the bridge, has local access to the drive and offers it as a pool node; the space's home reaches it over the Wink
// connection. Chunks are ciphertext before they leave the home (pool.js), so the bridge and the wire only ever carry bytes nobody can read; this file adds
// what ciphertext cannot give: who may ask, and that a request is fresh and not altered.
//
// The port (what tailnet supplies on each side):
//   bridge side:  createBridge({ dir, secret, capacity }).handle(frame) -> { status, body? }     (the Wink request handler for the offer; `serveBridge` is a plain HTTP form for tests)
//   home side:    bridgeBackend({ secret, send }) is the pool backend, `send(frame) -> { status, body? }` is the Wink call to the bridge device
//   frame:        { op: "put" | "get" | "del" | "ping", key, body?: Buffer, ts, nonce, sig }   (a nonce is accepted once inside the window, so a captured frame cannot be replayed)
// `secret` is made at pairing, held in the vault on both devices (never in the offer row), and signs every frame: HMAC-SHA256 over op, key, time and the body's
// hash. A frame older or newer than 60 s, with a bad key name, over capacity or over the size cap is refused. put, del and get are idempotent, so a replayed frame
// inside the window changes nothing new.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { dirBackend } from "./backends.js";

export const WINDOW_MS = 60_000;
export const MAX_BODY = 64 * 1024 * 1024;
/** The most one reply may carry back to the home (a chunk, its IV, tag and flag, with room): a hostile bridge cannot exhaust memory with one answer (S-8). */
export const MAX_OBJECT = 8 * 1024 * 1024;
const KEY = /^[A-Za-z0-9_\-/.]{1,200}$/;
const sha = b => crypto.createHash("sha256").update(b ?? "").digest("hex");
export const sign = (secret, { op, key, ts, nonce = "", body }) => crypto.createHmac("sha256", secret).update(`vyre-bridge-v2\n${op}\n${key}\n${ts}\n${nonce}\n${sha(body)}`).digest("base64url");

export function createBridge({ dir, secret, capacity = Infinity, now = Date.now }) {
  if (!secret || String(secret).length < 16) throw Object.assign(new Error("bridge needs a secret"), { code: "bad_secret" });
  const store = dirBackend(dir), startedAt = now(); // a frame signed before this process started may have been seen by the last one: refused (the nonce table is memory only)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sizes = new Map(), seen = new Map(); let used = 0;
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); try { const st = fs.statSync(p); if (st.isFile() && !p.endsWith(".tmp")) { sizes.set(String(f), st.size); used += st.size; } } catch { /* a file that vanished */ } }
  const ok = (status, body) => ({ status, ...(body ? { body } : {}) });
  return {
    get used() { return used; },
    async handle(f) {
      if (!f || !["put", "get", "del", "ping"].includes(f.op) || !Number.isFinite(f.ts) || typeof f.sig !== "string" || typeof f.nonce !== "string" || f.nonce.length < 8 || f.nonce.length > 64) return ok(400);
      if (Math.abs(now() - f.ts) > WINDOW_MS || f.ts < startedAt) return ok(401);
      const want = Buffer.from(sign(secret, { op: f.op, key: f.key ?? "", ts: f.ts, nonce: f.nonce, body: f.body })), got = Buffer.from(f.sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return ok(401);
      for (const [n, t] of seen) if (t < now()) seen.delete(n);
      if (seen.has(f.nonce)) return ok(409);
      seen.set(f.nonce, f.ts + WINDOW_MS);
      if (f.op === "ping") { const free = await store.ping().catch(() => null); return free === null ? ok(503) : ok(200, Buffer.from(String(Math.max(0, Math.min(capacity - used, free))))); }
      if (typeof f.key !== "string" || !KEY.test(f.key) || f.key.split("/").some(p => p === "" || p === "." || p === "..")) return ok(400);
      try {
        if (f.op === "put") {
          const b = Buffer.from(f.body ?? []); if (b.length > MAX_BODY) return ok(413);
          // Reserve before the write so two at once cannot both pass the check (S-10); give it back if the write fails.
          const had = sizes.get(f.key) ?? 0; if (used - had + b.length > capacity) return ok(507);
          used += b.length - had; sizes.set(f.key, b.length);
          try { await store.put(f.key, b); } catch (e) { used -= b.length - had; if (had) sizes.set(f.key, had); else sizes.delete(f.key); throw e; }
          return ok(200);
        }
        if (f.op === "get") { const b = await store.get(f.key); return b ? ok(200, b) : ok(404); }
        await store.del(f.key); used -= sizes.get(f.key) ?? 0; sizes.delete(f.key); return ok(200);
      } catch { return ok(500); }
    },
  };
}

/** The bridge as a plain HTTP server (tests, and a Wink transport that carries HTTP). The frame is in headers; the body is the object. Nothing is read before the headers make sense: a bad request is refused up front, a body is capped by its declared length and by the op, and a bad escape or any error is a 400, never a crash. */
export function serveBridge(bridge, { port = 0, host = "127.0.0.1", maxInflight = 8 } = {}) {
  let inflight = 0;
  const srv = http.createServer((req, res) => {
    const end = (status, body) => { if (!res.headersSent) { res.writeHead(status, { "content-length": body?.length ?? 0 }); res.end(body); } };
    const op = req.headers["x-vyre-op"], ts = Number(req.headers["x-vyre-ts"]), sig = String(req.headers["x-vyre-sig"] ?? ""), nonce = String(req.headers["x-vyre-nonce"] ?? "");
    const cap = op === "put" ? MAX_BODY : 0, len = Number(req.headers["content-length"] ?? 0);
    if (!["put", "get", "del", "ping"].includes(op) || !Number.isFinite(ts) || !sig || !nonce) { req.resume(); return end(400); }
    if (!Number.isFinite(len) || len > cap) { req.resume(); return end(413); }
    if (inflight >= maxInflight) { req.resume(); return end(503); }
    inflight++; const parts = []; let n = 0, done = false;
    const finish = () => { if (!done) { done = true; inflight--; } };
    req.on("data", d => { n += d.length; if (n > cap) { finish(); end(413); req.destroy(); } else parts.push(d); });
    req.on("error", finish); req.on("close", finish);
    req.on("end", async () => {
      try {
        const key = decodeURIComponent(req.url.slice(1)), body = Buffer.concat(parts);
        const r = await bridge.handle({ op, key, ts, nonce, sig, body: body.length ? body : undefined });
        end(r.status, r.body);
      } catch { end(400); } finally { finish(); }
    });
  });
  return new Promise(resolve => srv.listen(port, host, () => resolve({ server: srv, port: srv.address().port, close: () => new Promise(r => srv.close(() => r())) })));
}

/** The default `send`: the frame over HTTP to a bridge address. Wink supplies its own `send` and the same frame. */
export function httpSend(endpoint, { timeoutMs = 30_000, maxBytes = MAX_OBJECT } = {}) {
  const u = new URL(endpoint), lib = u.protocol === "https:" ? https : http;
  return f => new Promise((resolve, reject) => {
    const r = lib.request({ method: "POST", hostname: u.hostname, port: u.port || undefined, path: `/${encodeURIComponent(f.key ?? "")}`, timeout: timeoutMs,
      headers: { "x-vyre-op": f.op, "x-vyre-ts": String(f.ts), "x-vyre-nonce": f.nonce, "x-vyre-sig": f.sig, "content-length": f.body?.length ?? 0 } }, res => {
      const parts = []; let n = 0; res.on("data", d => { n += d.length; if (n > maxBytes) r.destroy(new Error("too big")); else parts.push(d); }); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", reject); r.end(f.body);
  });
}

/** The pool backend for a bridged drive. @param {{ secret: string, send: (f: any) => Promise<{ status: number, body?: Buffer }>, now?: () => number }} o */
export function bridgeBackend({ secret, send, now = Date.now }) {
  const call = async (op, key = "", body) => { const ts = now(), nonce = crypto.randomBytes(12).toString("base64url"); return send({ op, key, body, ts, nonce, sig: sign(secret, { op, key, ts, nonce, body }) }); };
  return {
    async put(k, v) { const r = await call("put", k, Buffer.from(v)); if (r.status !== 200) throw Object.assign(new Error(`bridge put ${r.status}`), { code: r.status === 507 ? "full" : "bridge" }); },
    async get(k) { const r = await call("get", k); if (r.status === 404) return null; if (r.status !== 200) throw new Error(`bridge get ${r.status}`); return r.body; },
    async del(k) { const r = await call("del", k); if (r.status !== 200) throw new Error(`bridge del ${r.status}`); },
    async ping() { const r = await call("ping"); if (r.status !== 200) throw new Error(`bridge ping ${r.status}`); return Number(String(r.body)); },
  };
}
