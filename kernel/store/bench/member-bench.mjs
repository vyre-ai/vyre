// A member whose only access is a project (an attribute equality grant): count by stage and a sorted page, with the store counting under the pushed predicate (attr_filter) and without
// (the gateway asking about every row). Seeds N matters across five projects through the gateway; the member holds one project (a fifth of the rows).
//   node kernel/store/bench/member-bench.mjs 20000,100000
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGateway } from "../../gateway/index.js";
import { createSqliteStore } from "../sqlite.js";
import { createEventLog } from "../../core/events.js";
import { createChainBuilder } from "../../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", MEMBER = "per_member";
const sizes = (process.argv[2] || "20000").split(",").map(Number);
let T = Date.now();
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const member = () => chains.fromFacts({ kind: "invitee", person: MEMBER, vouched: true });
const actor = id => ({ kind: "person", id, space: SPACE });
const G = (who, over = {}) => ({ id: `gr_${Math.random().toString(36).slice(2, 10)}`, space: SPACE, subject: { kind: "actor", actor: actor(who) }, actions: ["records.*", "records.define"], action_set_version: 1, resource: { prefix: `vyre://${SPACE}/*` }, status: "active", ...over });
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }, { name: "fee", kind: "number", label: "Fee" }] };
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-member-"));
const db = new DatabaseSync(path.join(dir, "kernel.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL");
const store = createSqliteStore({ db, clock });
const log = createEventLog({ space: SPACE, clock });
const grants = [G(OWNER), G(MEMBER, { actions: ["records.read"], resource: { prefix: `vyre://${SPACE}/matter/*`, where: [{ attr: "project", op: "eq", value: "p1" }] } })];
const known = new Set([`person:${OWNER}`, `person:${MEMBER}`]);
const mk = push => createGateway({ space: SPACE, store, log, chains, clock, attrs: () => ({}), ...(push ? { attrPush: () => true } : {}),
  grants: { forSubject: a => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => grants.find(g => g.id === id) },
  members: { has: a => known.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
const gwOn = mk(true), gwOff = mk(false);
await gwOn.records.define(owner(), { add_types: [MATTER] });
let n = 0;
for (const size of sizes) {
  const t0 = performance.now();
  while (n < size) { await Promise.all(Array.from({ length: Math.min(32, size - n) }, () => { const i = n++; return gwOn.records.create(owner(), "matter", { title: `Harlow ${i}`, stage: ["intake", "open", "closed"][i % 3], fee: i % 1000 }, { attrs: { project: `p${1 + (i % 5)}` } }); })); }
  console.error(`seeded ${n} in ${Math.round((performance.now() - t0) / 1000)} s`);
  {
    // the owner's count by stage: the store's kept counts (or its scan, on a store without them)
    const own = [];
    for (let i = 0; i < 30; i++) { const s0 = performance.now(); await gwOn.records.aggregate(owner(), "matter", { group_by: ["stage"], measures: [{ fn: "count" }] }); own.push(performance.now() - s0); }
    console.log(JSON.stringify({ records: n, path: "owner count by stage", count_p50_ms: Math.round(pct(own, 0.5) * 10) / 10, count_p95_ms: Math.round(pct(own, 0.95) * 10) / 10 }));
  }
  for (const [label, gw] of [["pushed (attr_filter)", gwOn], ["row by row", gwOff]]) {
    const count = [], list = [], reps = label.startsWith("row") ? 3 : 20;
    let rows = 0, err = null;
    for (let i = 0; i < reps; i++) {
      let s = performance.now();
      try { const r = await gw.records.aggregate(member(), "matter", { group_by: ["stage"], measures: [{ fn: "count" }] }); rows = r.reduce((a, g) => a + g.values.count, 0); } catch (e) { err = e.code; }
      count.push(performance.now() - s);
      s = performance.now();
      await gw.records.query(member(), "matter", { sort: [{ field: "fee", dir: "desc" }], page: { limit: 20 } });
      list.push(performance.now() - s);
    }
    console.log(JSON.stringify({ records: n, path: label, counted: rows, count_error: err, count_p50_ms: Math.round(pct(count, 0.5)), count_p95_ms: Math.round(pct(count, 0.95)), list_p50_ms: Math.round(pct(list, 0.5)), list_p95_ms: Math.round(pct(list, 0.95)), runs: reps }));
  }
}
fs.rmSync(dir, { recursive: true, force: true });
