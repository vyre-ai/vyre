// How long a restart takes, and what it holds, with N events of history (run by hand: `node boot-bench.mjs 100000 1000000`).
// It builds a durable kernel database with a few thousand real grants events (so the snapshots are real), then N record events of history and a signed checkpoint
// every 1,000 events, and times: opening the log, booting the whole kernel (grants rebuild, limits rebuild, the incremental boot check), and a full chain verify from zero.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootKernel } from "../../boot.js";
import { createCheckpointer, ed25519Signer } from "../../audit/index.js";
import { canonical, sha256 } from "../../core/canonical.js";

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
const SPACE = "spc_benchboot001", OWNER = "per_owner";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const mb = n => (n / 1048576).toFixed(0);
// a fixed key, so a kept database (KEEP) still verifies its checkpoints on a later run
const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]), format: "der", type: "pkcs8" });
const publicKey = crypto.createPublicKey(privateKey);

for (const N of sizes) {
  const dir = process.env.KEEP ? path.join(process.env.KEEP, `n${N}`) : fs.mkdtempSync(path.join(os.tmpdir(), "vyre-boot-"));
  fs.mkdirSync(dir, { recursive: true });
  const reuse = Boolean(process.env.KEEP) && fs.existsSync(path.join(dir, "built"));
  const file = path.join(dir, "kernel.db");
  /** @type {any} */ let db;
  const open = () => bootKernel({ db: (db = new DatabaseSync(file)), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence, checkpointKey: publicKey });
  let k = await open();
  const t0 = performance.now();
  if (!reuse) {
  const ow = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (let i = 0; i < 1500; i++) { const r = { person: `per_p${i}`, role: "member" }; await k.gateway.grants.setRole(ow, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/per_p${i}`) }); }
  const cp = createCheckpointer({ space: SPACE, log: k.log, chains: k.chains, sign: ed25519Signer(privateKey), key_id: "k1", every_events: 1000 });
  const filler = k.chains.fromFacts({ kind: "module", module: "bench", first_party: true });
  // one transaction per 1,000 events (a commit per event is an fsync per event: 70 events a second on a slow disk)
  db.exec("BEGIN");
  for (let i = 0; i < N; i++) { k.log.append(filler, { type: "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/c${i % 5000}`, data: { i, version: i, version_hash: `h${i}`, after: { name: `Client ${i}` } } }); if (i % 1000 === 999) { await cp.tick(); db.exec("COMMIT"); db.exec("BEGIN"); } if (i % 100000 === 99999) console.error(`built ${i + 1} of ${N} at ${((performance.now() - t0) / 1000).toFixed(0)} s`); }
  await cp.sign();
  db.exec("COMMIT");
  if (process.env.KEEP) fs.writeFileSync(path.join(dir, "built"), "1");
  await k.stop?.();
  }
  if (reuse) await k.stop?.();
  const events = k.log.latestSeq(), written = ((performance.now() - t0) / 1000).toFixed(0);
  const size = (fs.statSync(file).size / 1048576).toFixed(0);
  global.gc?.();
  const t1 = performance.now();
  k = await open();
  const boot = performance.now() - t1;
  const t2 = performance.now(); const full = k.log.verify(); const verify = performance.now() - t2;
  console.log(JSON.stringify({ events, db_mb: Number(size), built_s: Number(written), boot_ms: Math.round(boot), boot_check: k.boot, rss_after_boot_mb: Number(mb(process.memoryUsage().rss)), heap_mb: Number(mb(process.memoryUsage().heapUsed)), in_memory_events: k.log.stats().in_memory, full_verify_s: Number((verify / 1000).toFixed(1)), full_verify_ok: full.ok }));
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
