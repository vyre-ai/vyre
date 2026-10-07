// Run by hand across two machines (a drive exported on one, a space whose home is the other):
//   box A (the drive):  node kernel/storage/bridge.cross.js serve /srv/drive 0.0.0.0 9400 SECRET
//   box B (the home):   node kernel/storage/bridge.cross.js pool http://BOXA:9400 SECRET
//   box B, the home dies: node kernel/storage/bridge.cross.js restore http://BOXA:9400 SECRET   (backs up the index, wipes the home, restores from the drive alone, reads a file back)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridge, serveBridge, httpSend, bridgeBackend } from "./bridge.js";
import { Pool } from "./pool.js";
import { dirBackend } from "./backends.js";
import { Drive } from "./drive.js";
import { backupIndex, restoreIndex } from "./indexbackup.js";
import { startSealer } from "../seal/client.js";

const [mode, a, b, c, d] = process.argv.slice(2), MB = 1 << 20;
if (mode === "serve") {
  const br = createBridge({ dir: a, secret: d, capacity: 200 * MB }), s = await serveBridge(br, { host: b, port: Number(c) });
  console.log(`bridge serving ${a} on ${b}:${s.port}`); await new Promise(() => {});
} else if (mode === "restore") {
  const be = bridgeBackend({ secret: b, send: httpSend(a) }), root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-restore-")), sdir = path.join(root, "seal");
  const sealer = startSealer({ dir: sdir, dev: true, timeoutMs: 15000 }), owner = "spc_harlowharlowharlow", key = await sealer.poolKey({ owner });
  const mk = (dir, bk) => { const p = new Pool({ dir, key, chunk: MB }); p.addNode({ id: "home", backend: dirBackend(path.join(dir, "node")), home: true, offered: 500 * MB }); p.addNode({ id: "office", backend: bk, kind: "network_drive", site: "office", offered: 100 * MB }); return p; };
  const home1 = path.join(root, "home1"), pool = mk(home1, be), drive = new Drive(pool);
  const doc = crypto.randomBytes(3 * MB + 5), note = Buffer.from("Harlow Legal estate plan");
  await drive.put("clients/jane/estate.bin", doc, { by: "per_alex" }); await drive.put("clients/jane/notes.txt", note, { by: "per_alex" });
  const head = await backupIndex({ pool, drive, key, owner }); console.log("index backed up:", JSON.stringify({ seq: head.seq, copies: head.copies, hash: head.hash.slice(0, 12) }));
  fs.rmSync(home1, { recursive: true, force: true }); console.log("home wiped: index, drive file and local chunks are gone");
  const home2 = path.join(root, "home2"), r = await restoreIndex({ dir: home2, key, owner, nodes: [{ id: "office", backend: be }], expected: { seq: head.seq, hash: head.hash } });
  console.log("restored:", JSON.stringify({ seq: r.seq, unverified: r.unverified, lost_nodes: r.lost_nodes }));
  const pool2 = mk(home2, be), drive2 = new Drive(pool2);
  assert.deepEqual(drive2.list().map(f => f.path).sort(), ["clients/jane/estate.bin", "clients/jane/notes.txt"]);
  assert.deepEqual(await drive2.get("clients/jane/estate.bin"), doc); assert.deepEqual(await drive2.get("clients/jane/notes.txt"), note); console.log("read both files back from the office drive alone: ok");
  const h = await pool2.heal(); console.log("heal on the new home:", JSON.stringify(h)); assert.equal(h.atRisk, 0);
  await sealer.close(); fs.rmSync(root, { recursive: true, force: true });
} else {
  const be = bridgeBackend({ secret: b, send: httpSend(a) }), dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-cross-"));
  const pool = new Pool({ dir, key: Buffer.alloc(32, 8), chunk: MB });
  pool.addNode({ id: "home", backend: dirBackend(path.join(dir, "home")), home: true, offered: 500 * MB });
  pool.addNode({ id: "office", backend: be, kind: "network_drive", site: "office", offered: 100 * MB });
  await pool.probe(); const t0 = Date.now();
  const data = crypto.randomBytes(8 * MB + 123), w = await pool.put(data, { class: "working" }), k = await pool.put(crypto.randomBytes(3 * MB), { class: "backup" });
  console.log(`put 11 MB: ${Date.now() - t0} ms, working atRisk=${w.atRisk}, backup atRisk=${k.atRisk}`);
  assert.equal(w.atRisk, false); assert.deepEqual(await pool.get(w.id), data);
  const onOffice = Object.values(pool.ix.chunks).filter(x => x.nodes.includes("office")).length; console.log(`chunks on the office drive: ${onOffice} of ${Object.keys(pool.ix.chunks).length}`);
  assert.ok(onOffice >= 10);
  // The home loses its own copy: reads come from the office drive.
  for (const cid of Object.keys(pool.ix.chunks)) { const x = pool.ix.chunks[cid]; if (x.nodes.includes("home")) await pool.nodes.get("home").backend.del(`c/${cid}`); }
  assert.deepEqual(await pool.get(w.id), data); console.log("read back from the office drive alone: ok");
  console.log("report:", JSON.stringify({ usable: pool.report().usable, nudges: pool.report().nudges }));
  fs.rmSync(dir, { recursive: true, force: true });
}
