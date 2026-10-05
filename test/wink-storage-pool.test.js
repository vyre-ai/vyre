// @ts-check
// A storage device paired through Wink joins the Space's pool: on a real vyred with the kernel on, an S3-compatible bucket is paired (wink.storage.pair), a file is written twice to the Space's Drive, and the
// first version's encrypted chunk is put in the bucket. Before the pool was wired into the Wink module, a paired drive was recorded and nothing was ever placed on it. 127.0.0.1 only; run on a test box.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { macCore } from "./fake-core-keys.js";
import { createRelay } from "../relay/node/server.js";

const PROOF = { proof: { method: "passkey", id: "x" } };
const lenient = {
  required: () => false,
  verify: async () => ({ ok: true, method: "passkey", keyId: "k1" }),
  challenge: async () => ({ error: { code: "bad_input", message: "none" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll() { return { id: "k" }; },
};

/** A bucket on disk: path-style, keeps what it is given, answers the list the pairing check makes. */
async function bucket(t, name) {
  const puts = [];
  const store = new Map();
  const srv = http.createServer((req, res) => {
    const u = new URL(String(req.url), "http://x"), parts = decodeURIComponent(u.pathname).split("/").filter(Boolean);
    if (!String(req.headers.authorization || "").startsWith("AWS4-HMAC-SHA256")) { res.statusCode = 403; return res.end("<Error><Code>AccessDenied</Code></Error>"); }
    if (parts[0] !== name) { res.statusCode = 404; return res.end("<Error><Code>NoSuchBucket</Code></Error>"); }
    const key = parts.slice(1).join("/");
    if (!key) { res.setHeader("content-type", "application/xml"); return res.end(`<?xml version="1.0"?><ListBucketResult><Name>${name}</Name><KeyCount>0</KeyCount></ListBucketResult>`); }
    if (req.method === "PUT") { const c = []; req.on("data", d => c.push(d)); req.on("end", () => { store.set(key, Buffer.concat(c)); puts.push(key); res.end(); }); return; }
    if (req.method === "GET") { const b = store.get(key); if (!b) { res.statusCode = 404; return res.end(); } return res.end(b); }
    if (req.method === "DELETE") { store.delete(key); res.statusCode = 204; return res.end(); }
    res.statusCode = 405; res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { srv.closeAllConnections(); srv.close(); });
  return { endpoint: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`, puts, store };
}

test("a bucket paired through Wink holds the Drive's cold chunks, and the file reads back", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const b = await bucket(t, "vyrebucket");
  const relay = createRelay(), url = await relay.listen();
  t.after(() => relay.close());
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex" }, relay: { enabled: true, url }, modules: { disable: ["names", "onboard"] } }));
  const d = await start({ presence: lenient, root, log: m => { if (process.env.WLOG) console.error(m); }, coreKeys: macCore(), kernel: true });
  t.after(() => d.stop());
  const call = (tool, input = {}) => d.registry.call(tool, input, "cli", { ...PROOF, person: { id: "ps1" } });
  const T = m => { if (process.env.WLOG) console.error("T:", m); };
  T("started");
  const paired = await call("wink.storage.pair", { kind: "s3", endpoint: b.endpoint, bucket: "vyrebucket", region: "us-east-1", accessKey: "AKIATEST", secretKey: "secretsecretsecretsecret", name: "test bucket", capacity: 1e9 });
  assert.ok(paired.data && paired.data.device && paired.data.device.id, JSON.stringify(paired.error || paired));
  T("paired");
  // the Space's pool, as the Wink module holds it (kernel handle for the module named wink): the drive's node joins within the sync that follows the pairing
  const pool = d.kernel.kernelFor({ name: "wink" }).storage.pool;
  for (let i = 0; i < 100 && !pool.nodes.has(paired.data.device.id); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(pool.nodes.has(paired.data.device.id), "the paired bucket is a node of the pool");
  const plain = Buffer.from("a cold file's bytes ".repeat(40));
  const put = await pool.put(plain, { class: "cold" });
  for (let i = 0; i < 100 && !b.puts.length; i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(b.puts.length >= 1, "a chunk was put in the bucket");
  assert.ok(b.puts.every(k => k.startsWith(`vyre/${paired.data.device.id}/`)), "under the device's own prefix");
  for (const buf of b.store.values()) assert.ok(!buf.includes(Buffer.from("a cold file")), "only ciphertext leaves the home");
  assert.deepEqual(Buffer.from(await pool.get(put.id)), plain, "and the file reads back");
});
