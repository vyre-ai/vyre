// A restart must not scan the log: the kernel reads its grants, members, rules and chats by event type prefix (`grant.*`, `member.*`, ...), and a prefix read that the type index cannot serve
// (it was `LIKE ? ESCAPE`) scanned and parsed every event: 4 s at 100,000 events, 39 s at 1,000,000. This builds a 100,000-event database directly (rows inserted in one transaction, so it takes a
// second, not minutes) and holds the restart to a bound that the scan missed by a wide margin and the index meets by a wide margin (528 ms on the test box; the scan was about 4,000 ms).
// The budget (team/0.3/KERNEL-size.md) is 3 s and 200 MB at 1,000,000 events, measured by kernel/store/bench/boot-bench.mjs; this is the smaller check that runs every time.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { createSqliteEventLog } from "./sqlite-log.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const N = 100_000, BOUND_MS = 1800;

test(`a restart over ${N.toLocaleString("en")} events reads by type prefix from the index and boots within ${BOUND_MS} ms`, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-bootperf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  // a real first start makes the owner and the tables
  let db = new DatabaseSync(file);
  let k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const first = k.log.latestSeq();
  db.close();
  // history: contact events, inserted straight into the table (the boot reads them by type and by window, it does not verify them without a checkpoint key)
  db = new DatabaseSync(file);
  const ins = db.prepare("INSERT INTO kernel_events (seq, space, event, salt) VALUES (?, ?, ?, NULL)");
  db.exec("BEGIN");
  for (let i = 1; i <= N; i++) ins.run(first + i, SPACE, JSON.stringify({ seq: first + i, type: "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/c${i % 5000}`, time: 1_800_000_000_000 + i, prev: "p", hash: "h", data: { i, version: i, after: { name: `Client ${i}` } }, vis: "subject", red: "internal", actor: "service:bench", hops: [] }));
  db.exec("COMMIT");
  db.close();
  // the prefix reads the kernel makes at boot are served by the type index
  db = new DatabaseSync(file);
  for (const prefix of ["grant.", "member.", "actor.", "offer.", "invite.", "chat.", "rule."]) {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event FROM kernel_events WHERE space = ? AND seq > ? AND type >= ? AND type < ? ORDER BY seq LIMIT ?").all(SPACE, 0, prefix, prefix.slice(0, -1) + "/", 100).map(r => r.detail).join(" | ");
    assert.match(plan, /kernel_events_type/, `${prefix}: ${plan}`);
  }
  const t0 = performance.now();
  k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const ms = performance.now() - t0;
  assert.ok(k.log.latestSeq() >= first + N);
  assert.ok(ms < BOUND_MS, `a restart over ${N} events took ${Math.round(ms)} ms (bound ${BOUND_MS}); a scan of the log is back`);
  db.close();
});
