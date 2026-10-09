// kernel/storage/backends.js: where a pool node's bytes actually go. Every backend holds only ciphertext (pool.js encrypts before it writes), so a
// backend never needs trusting with content. Shape: put(key, buf), get(key) -> Buffer|null, del(key), ping() -> bytes free on the device or null if unknown.
// dirBackend covers a local disk, a USB disk, a mounted network drive and an attached cloud volume (all are a folder to the pool). s3Backend covers
// S3 and any S3-compatible bucket, SeaweedFS and Garage included, signed with AWS Signature V4 using only node built-ins.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { userHostFetch } from "../../lib/http.js";

export function memoryBackend({ free = Infinity } = {}) {
  const m = new Map(), b = { m, down: false, free,
    async put(k, v) { if (b.down) throw new Error("down"); m.set(k, Buffer.from(v)); },
    async get(k) { if (b.down) throw new Error("down"); return m.get(k) ?? null; },
    async del(k) { if (b.down) throw new Error("down"); m.delete(k); },
    async ping() { if (b.down) throw new Error("down"); return b.free; } };
  return b;
}

const safe = k => { if (!/^[A-Za-z0-9_\-/.]+$/.test(k) || k.split("/").some(p => p === ".." || p === "." || p === "")) throw new Error("bad key"); return k; };
export function dirBackend(root) {
  const at = k => path.join(root, safe(k));
  return {
    root,
    async put(k, v) { const f = at(k), t = `${f}.${crypto.randomBytes(4).toString("hex")}.tmp`; fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(t, v, { mode: 0o600 }); fs.renameSync(t, f); },
    async get(k) { try { return fs.readFileSync(at(k)); } catch (e) { if (e.code === "ENOENT") return null; throw e; } },
    async del(k) { fs.rmSync(at(k), { force: true }); },
    async ping() { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.accessSync(root, fs.constants.W_OK); const s = fs.statfsSync(root); return Number(s.bavail) * Number(s.bsize); },
  };
}

const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
const sha = d => crypto.createHash("sha256").update(d).digest("hex");
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
/** AWS Signature V4 for one request (path-style). Exported for the test against the published signing-key vector. */
export function signV4({ method, host, path: p, query = "", headers = {}, payloadHash, region, service = "s3", key, secret, now = new Date() }) {
  const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = amz.slice(0, 8);
  const h = { ...headers, host, "x-amz-date": amz, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(h).map(x => x.toLowerCase()).sort();
  const canon = [method, p.split("/").map(enc).join("/"), query, names.map(n => `${n}:${String(h[Object.keys(h).find(x => x.toLowerCase() === n)]).trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`, sts = ["AWS4-HMAC-SHA256", amz, scope, sha(canon)].join("\n");
  const sk = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), "aws4_request");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${crypto.createHmac("sha256", sk).update(sts).digest("hex")}`;
  return h;
}
export function s3Backend({ endpoint, bucket, key, secret, region = "us-east-1", prefix = "", timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024 }) {
  const u = new URL(endpoint);
  // The bucket's address is the person's own (a LAN SeaweedFS or Garage as often as AWS), so the address rule is theirs; the rest (deadline, size cap, no retry of a signed call) is lib/http.js.
  const call = async (method, objKey, body) => {
    const p = `/${bucket}${objKey ? `/${prefix}${objKey}` : ""}`, ph = sha(body ?? ""), hd = signV4({ method, host: u.host, path: p, payloadHash: ph, region, key, secret, headers: body ? { "content-length": body.length } : {} });
    const res = await userHostFetch(`${u.origin}${p.split("/").map(enc).join("/")}`, { method, headers: hd, body, timeoutMs, maxBytes, retries: 0, redirect: "manual" });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };
  return {
    async put(k, v) { const r = await call("PUT", safe(k), Buffer.from(v)); if (r.status >= 300) throw new Error(`s3 put ${r.status}`); },
    async get(k) { const r = await call("GET", safe(k)); if (r.status === 404) return null; if (r.status >= 300) throw new Error(`s3 get ${r.status}`); return r.body; },
    async del(k) { const r = await call("DELETE", safe(k)); if (r.status >= 300 && r.status !== 404) throw new Error(`s3 del ${r.status}`); },
    async ping() { const r = await call("HEAD", ""); if (r.status >= 300) throw new Error(`s3 head ${r.status}`); return null; },
  };
}
