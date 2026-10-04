// How fast the REAL write path commits: a kernel on a file database opened the way the daemon opens it (core/store open: WAL, and synchronous at SQLite's default, FULL), W concurrent writers
// each creating then updating a record through the gateway for a few seconds. Prints events a second (the log's growth) and p50/p95/p99 of a write, per W.
//   SYNC=FULL|NORMAL node kernel/store/bench/write-bench.mjs 1,20,100 8     (writers, seconds each)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootKernel } from "../../boot.js";
import { CONTACT } from "../../conformance/suite.js";

const [writersArg = "1,20,100", secArg = "8"] = process.argv.slice(2);
const SYNC = process.env.SYNC || "FULL", SECONDS = Number(secArg);
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-write-"));
const db = new DatabaseSync(path.join(home, "kernel.db"));
db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=${SYNC};`);
const SPACE = "spc_writebench01", OWNER = "per_owner";
const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
const chain = () => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
const R = k.gateway.records;
await R.define(chain(), { add_types: [CONTACT] });
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
for (const W of writersArg.split(",").map(Number)) {
  const lat = [], until = Date.now() + SECONDS * 1000, e0 = k.log.latestSeq();
  const t0 = performance.now();
  const writer = async w => {
    let n = 0;
    while (Date.now() < until) {
      let s = performance.now();
      const r = await R.create(chain(), "contact", { name: `W${w} #${++n}`, age: 30 });
      lat.push(performance.now() - s);
      s = performance.now();
      await R.update(chain(), "contact", r.id, { age: 31 }, r.version);
      lat.push(performance.now() - s);
    }
  };
  await Promise.all(Array.from({ length: W }, (_, w) => writer(w)));
  const secs = (performance.now() - t0) / 1000, events = k.log.latestSeq() - e0;
  console.log(JSON.stringify({ sync: SYNC, writers: W, writes: lat.length, writes_per_s: Math.round(lat.length / secs), events_per_s: Math.round(events / secs), p50_ms: +pct(lat, 0.5).toFixed(1), p95_ms: +pct(lat, 0.95).toFixed(1), p99_ms: +pct(lat, 0.99).toFixed(1), load: os.loadavg().map(x => x.toFixed(1)).join(" ") }));
}
fs.rmSync(home, { recursive: true, force: true });
