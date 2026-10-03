// Run by hand across two machines (a drive exported on one, a space whose home is the other):
//   box A (the drive):  node kernel/storage/bridge.cross.js serve /srv/drive 0.0.0.0 9400 SECRET
//   box B (the home):   node kernel/storage/bridge.cross.js pool http://BOXA:9400 SECRET
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBridge, serveBridge, httpSend, bridgeBackend } from "./bridge.js";
import { Pool } from "./pool.js";
import { dirBackend } from "./backends.js";

const [mode, a, b, c, d] = process.argv.slice(2), MB = 1 << 20;
if (mode === "serve") {
  const br = createBridge({ dir: a, secret: d, capacity: 200 * MB }), s = await serveBridge(br, { host: b, port: Number(c) });
  console.log(`bridge serving ${a} on ${b}:${s.port}`); await new Promise(() => {});
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
