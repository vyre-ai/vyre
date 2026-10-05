// A project's memory moves between two Spaces: offer, export (sealed), import (receipt), forget (needs the receipt), with the kernel's events as the one approval.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./schema.js";
import { createMoves, slugOf } from "./move.js";

const db = () => { const d = new DatabaseSync(":memory:"); for (const m of MIGRATIONS) d.exec(m); return d; };
const MOVE = "0190c3f2-1111-4abc-8def-0000000000aa", PLAN = "p".repeat(43), PROJECT = "vyre://spc_aaaaaaaaaaaa/project/0190c3f2-1111-4abc-8def-000000000001";
const world = () => {
  const a = db(), b = db();
  const now = Date.now();
  const ev = { a: [{ type: "project.move_started", subject: PROJECT, data: { move_id: MOVE, to: "spc_bbbbbbbbbbbb", plan_hash: PLAN }, time: now }], b: [{ type: "project.move_in", subject: "vyre://spc_bbbbbbbbbbbb/project/" + MOVE, data: { move_id: MOVE, from: "spc_aaaaaaaaaaaa", project: PROJECT, plan_hash: PLAN }, time: now }] };
  const src = createMoves({ db: a, space: "spc_aaaaaaaaaaaa", events: t => ev.a.filter(e => e.type === t) });
  const dst = createMoves({ db: b, space: "spc_bbbbbbbbbbbb", events: t => ev.b.filter(e => e.type === t) });
  const w = a.prepare(`INSERT INTO memory_writes (id, kind, text, from_kind, from_name, untrusted, state, at, updated) VALUES (?,?,?,?,?,0,'live',?,?)`);
  w.run("w1", "fact", "Northwind pays on the 15th", "agent", "kit", 1, 1); w.run("w2", "note", "Dana prefers email", "person", "owner", 2, 2); w.run("w3", "fact", "Other project fact", "agent", "kit", 3, 3);
  const l = a.prepare("INSERT INTO memory_write_links (write, project, state, at) VALUES (?,?, 'live', 1)");
  l.run("w1", "northwind"); l.run("w2", "northwind"); l.run("w2", "harlow"); l.run("w3", "harlow");
  a.prepare("INSERT INTO memory_decisions (id, session, seq, project, cwd, topic, label, value, display, statement, revert, decided_at) VALUES ('d1','s1',1,'northwind','/x','billing','Billing','weekly','weekly','bill weekly',0,5)").run();
  a.prepare("INSERT INTO memory_corrections (action, src, scope, created) VALUES ('wrong','name:X','northwind',1)").run();
  return { a, b, src, dst, ev };
};
const run = async (m, out) => { const o = await m.dst.offer({ move_id: MOVE, plan_hash: PLAN, project: PROJECT }); const e = await m.src.export({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", to_key: o.to_key }); return out ? out(e) : e; };

test("room move: the package opens only in the target, lands in one transaction, and the source forgets only with the receipt", async () => {
  const m = world();
  const e = await run(m);
  assert.deepEqual(e.counts, { writes: 2, decisions: 1, corrections: 1, decision_fixes: 0 });
  const wire = JSON.stringify(e.package);
  assert.ok(!wire.includes("Northwind pays") && !wire.includes("Dana prefers"), "only ciphertext leaves the source");
  const receipt = await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e.package });
  assert.equal(receipt.digest, e.digest);
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_writes").get().n, 2);
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_write_links WHERE project = 'northwind'").get().n, 2);
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_decisions WHERE project = 'northwind'").get().n, 1);
  assert.deepEqual(await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e.package }), receipt, "a repeat is a no-op with the same receipt");
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_writes").get().n, 2);
  // forget needs the receipt of THIS move
  await assert.rejects(() => m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt: { ...receipt, move_id: "other" } }), /needs the receipt/);
  await assert.rejects(() => m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt: null }), /needs the receipt/);
  const gone = await m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt });
  assert.equal(gone.moved_to, "spc_bbbbbbbbbbbb");
  assert.equal(m.a.prepare("SELECT COUNT(*) n FROM memory_writes WHERE id = 'w1'").get().n, 0, "w1 was only Northwind's: gone for good");
  assert.equal(m.a.prepare("SELECT COUNT(*) n FROM memory_writes WHERE id = 'w2'").get().n, 1, "w2 is also Harlow's: kept for Harlow");
  assert.equal(m.a.prepare("SELECT COUNT(*) n FROM memory_write_links WHERE project = 'northwind'").get().n, 0);
  assert.equal(m.a.prepare("SELECT COUNT(*) n FROM memory_writes WHERE id = 'w3'").get().n, 1, "another project is untouched");
  assert.equal(m.src.movedTo(PROJECT), "spc_bbbbbbbbbbbb");
});

test("room move: refused without the kernel's event for this move, project and plan; a changed project is not forgotten; a stranger's key opens nothing", async () => {
  const m = world();
  await assert.rejects(() => m.dst.offer({ move_id: MOVE, plan_hash: "q".repeat(43), project: PROJECT }), /no such move/);
  await assert.rejects(() => m.dst.offer({ move_id: "0190c3f2-1111-4abc-8def-0000000000ff", plan_hash: PLAN, project: PROJECT }), /no such move/);
  const o0 = await m.dst.offer({ move_id: MOVE, plan_hash: PLAN, project: PROJECT });
  await assert.rejects(() => m.src.export({ move_id: MOVE, plan_hash: PLAN, project: PROJECT.replace("0001", "0002"), slug: "northwind", to_key: o0.to_key }), /no such move/);
  const e = await run(m);
  // a package sealed for another move's key does not open
  const other = world();
  await assert.rejects(() => other.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e.package }), /no offer|does not open/);
  const receipt = await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e.package });
  m.a.prepare("INSERT INTO memory_write_links (write, project, state, at) VALUES ('w3','northwind','live',9)").run();
  await assert.rejects(() => m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt }), /changed since/);
  assert.equal(m.a.prepare("SELECT COUNT(*) n FROM memory_writes WHERE id = 'w1'").get().n, 1, "nothing was lost");
  assert.equal(slugOf("vyre://s/project/northwind", []), "northwind");
  assert.equal(slugOf(PROJECT, [{ slug: "nw", id: "0190c3f2-1111-4abc-8def-000000000001" }]), "nw");
});

test("room move: a write between export and forget does not wedge the move; a digest that does not match is refused", async () => {
  const m = world();
  const e1 = await run(m);
  await assert.rejects(() => m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e1.package, digest: "0".repeat(64) }), /does not match the digest/);
  const r1 = await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e1.package, digest: e1.digest });
  // the project changes before forget: a new fact is filed
  m.a.prepare(`INSERT INTO memory_writes (id, kind, text, from_kind, from_name, untrusted, state, at, updated) VALUES ('w9','note','Late note','agent','kit',0,'live',9,9)`).run();
  m.a.prepare("INSERT INTO memory_write_links (write, project, state, at) VALUES ('w9','northwind','live',9)").run();
  await assert.rejects(() => m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt: r1 }), /changed since/);
  // export and import again, as the error says: the new package replaces the rows and gives a new receipt
  const o = await m.dst.offer({ move_id: MOVE, plan_hash: PLAN, project: PROJECT });
  const e2 = await m.src.export({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", to_key: o.to_key });
  assert.notEqual(e2.digest, e1.digest);
  const r2 = await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e2.package, digest: e2.digest });
  assert.equal(r2.digest, e2.digest);
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_writes WHERE id = 'w9'").get().n, 1, "the late note arrived");
  assert.equal((await m.dst.import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e2.package })).digest, e2.digest, "the same package again is the same receipt");
  const gone = await m.src.forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt: r2 });
  assert.equal(gone.forgotten.writes, 3);
});

test("room move per call: the object is built for each call from the Space it runs in; the one-use keys are the module's, shared across calls, and each Space reads its own log", async () => {
  const m = world();
  const offers = new Map();
  // what the module does on every call: a fresh createMoves over the running Space's own store and log, and the one shared map of keys
  const inSource = () => createMoves({ db: m.a, space: "spc_aaaaaaaaaaaa", offers, events: t => m.ev.a.filter(e => e.type === t) });
  const inTarget = () => createMoves({ db: m.b, space: "spc_bbbbbbbbbbbb", offers, events: async t => m.ev.b.filter(e => e.type === t) });
  const o = await inTarget().offer({ move_id: MOVE, plan_hash: PLAN, project: PROJECT });
  const e = await inSource().export({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", to_key: o.to_key });
  const r = await inTarget().import({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, package: e.package, digest: e.digest });
  assert.equal(r.digest, e.digest);
  assert.equal(m.b.prepare("SELECT COUNT(*) n FROM memory_writes").get().n, 2, "landed in the target Space's own store");
  // the home's log (the source's) holds no move_in: a target call reading it finds no such move, which is the bug this fixes
  await assert.rejects(() => createMoves({ db: m.b, space: "spc_bbbbbbbbbbbb", offers, events: t => m.ev.a.filter(x => x.type === t) }).offer({ move_id: MOVE, plan_hash: PLAN, project: PROJECT }), /no such move/);
  assert.equal((await inSource().forget({ move_id: MOVE, plan_hash: PLAN, project: PROJECT, slug: "northwind", receipt: r })).moved_to, "spc_bbbbbbbbbbbb");
  assert.equal(offers.size, 1);
});
