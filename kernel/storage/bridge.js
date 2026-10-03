// kernel/storage/bridge.js: a drive that only another device can reach (the user's own example: a drive plugged into the office network, shared with the
// space). A device on that network, the bridge, has local access to the drive and offers it as a pool node; the space's home reaches it over the Wink
// connection. Chunks are ciphertext before they leave the home (pool.js), so the bridge and the wire only ever carry bytes nobody can read; this file adds
// what ciphertext cannot give: who may ask, and that a request is fresh and not altered.
//
// The port (what tailnet supplies on each side):
//   bridge side:  createBridge({ dir, secret, capacity }).handle(frame) -> { status, body? }     (the Wink request handler for the offer; `serveBridge` is a plain HTTP form for tests)
//   home side:    bridgeBackend({ secret, send }) is the pool backend, `send(frame) -> { status, body? }` is the Wink call to the bridge device
//   frame:        { op: "put" | "get" | "del" | "ping", key, body?: Buffer, ts, sig }
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
const KEY = /^[A-Za-z0-9_\-/.]{1,200}$/;
const sha = b => crypto.createHash("sha256").update(b ?? "").digest("hex");
export const sign = (secret, { op, key, ts, body }) => crypto.createHmac("sha256", secret).update(`vyre-bridge-v1\n${op}\n${key}\n${ts}\n${sha(body)}`).digest("base64url");

export function createBridge({ dir, secret, capacity = Infinity, now = Date.now }) {
  if (!secret || String(secret).length < 16) throw Object.assign(new Error("bridge needs a secret"), { code: "bad_secret" });
  const store = dirBackend(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const sizes = new Map(); let used = 0;
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); try { const st = fs.statSync(p); if (st.isFile() && !p.endsWith(".tmp")) { sizes.set(String(f), st.size); used += st.size; } } catch { /* a file that vanished */ } }
  const ok = (status, body) => ({ status, ...(body ? { body } : {}) });
  return {
    get used() { return used; },
    async handle(f) {
      if (!f || !["put", "get", "del", "ping"].includes(f.op) || typeof f.ts !== "number" || typeof f.sig !== "string") return ok(400);
      if (Math.abs(now() - f.ts) > WINDOW_MS) return ok(401);
      const want = Buffer.from(sign(secret, { op: f.op, key: f.key ?? "", ts: f.ts, body: f.body })), got = Buffer.from(f.sig);
      if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return ok(401);
      if (f.op === "ping") { const free = await store.ping().catch(() => null); return free === null ? ok(503) : ok(200, Buffer.from(String(Math.max(0, Math.min(capacity - used, free))))); }
      if (typeof f.key !== "string" || !KEY.test(f.key) || f.key.split("/").some(p => p === "" || p === "." || p === "..")) return ok(400);
      try {
        if (f.op === "put") {
          const b = Buffer.from(f.body ?? []); if (b.length > MAX_BODY) return ok(413);
          const had = sizes.get(f.key) ?? 0; if (used - had + b.length > capacity) return ok(507);
          await store.put(f.key, b); sizes.set(f.key, b.length); used += b.length - had; return ok(200);
        }
        if (f.op === "get") { const b = await store.get(f.key); return b ? ok(200, b) : ok(404); }
        await store.del(f.key); used -= sizes.get(f.key) ?? 0; sizes.delete(f.key); return ok(200);
      } catch { return ok(500); }
    },
  };
}

/** The bridge as a plain HTTP server (tests, and a Wink transport that carries HTTP). The frame is in headers; the body is the object. */
export function serveBridge(bridge, { port = 0, host = "127.0.0.1" } = {}) {
  const srv = http.createServer((req, res) => {
    const parts = []; let n = 0;
    req.on("data", d => { n += d.length; if (n > MAX_BODY + 1024) req.destroy(); else parts.push(d); });
    req.on("end", async () => {
      const key = decodeURIComponent(req.url.slice(1)), body = Buffer.concat(parts);
      const r = await bridge.handle({ op: req.headers["x-vyre-op"], key, ts: Number(req.headers["x-vyre-ts"]), sig: String(req.headers["x-vyre-sig"] ?? ""), body: body.length ? body : undefined });
      res.writeHead(r.status, { "content-length": r.body?.length ?? 0 }); res.end(r.body);
    });
  });
  return new Promise(resolve => srv.listen(port, host, () => resolve({ server: srv, port: srv.address().port, close: () => new Promise(r => srv.close(() => r())) })));
}

/** The default `send`: the frame over HTTP to a bridge address. Wink supplies its own `send` and the same frame. */
export function httpSend(endpoint, { timeoutMs = 30_000 } = {}) {
  const u = new URL(endpoint), lib = u.protocol === "https:" ? https : http;
  return f => new Promise((resolve, reject) => {
    const r = lib.request({ method: "POST", hostname: u.hostname, port: u.port || undefined, path: `/${encodeURIComponent(f.key ?? "")}`, timeout: timeoutMs,
      headers: { "x-vyre-op": f.op, "x-vyre-ts": String(f.ts), "x-vyre-sig": f.sig, "content-length": f.body?.length ?? 0 } }, res => {
      const parts = []; res.on("data", d => parts.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout"))); r.on("error", reject); r.end(f.body);
  });
}

/** The pool backend for a bridged drive. @param {{ secret: string, send: (f: any) => Promise<{ status: number, body?: Buffer }>, now?: () => number }} o */
export function bridgeBackend({ secret, send, now = Date.now }) {
  const call = async (op, key = "", body) => { const ts = now(); return send({ op, key, body, ts, sig: sign(secret, { op, key, ts, body }) }); };
  return {
    async put(k, v) { const r = await call("put", k, Buffer.from(v)); if (r.status !== 200) throw Object.assign(new Error(`bridge put ${r.status}`), { code: r.status === 507 ? "full" : "bridge" }); },
    async get(k) { const r = await call("get", k); if (r.status === 404) return null; if (r.status !== 200) throw new Error(`bridge get ${r.status}`); return r.body; },
    async del(k) { const r = await call("del", k); if (r.status !== 200) throw new Error(`bridge del ${r.status}`); },
    async ping() { const r = await call("ping"); if (r.status !== 200) throw new Error(`bridge ping ${r.status}`); return Number(String(r.body)); },
  };
}
