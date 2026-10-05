// @ts-check
// Moving a Project between Spaces, engine only: two in-memory Spaces. The new project has a new id and folder, linked records and files arrive with links rewritten, a bad file or a changed project
// stops it before anything is removed, sealed fields move only through the sealing port, and the old Space keeps a marker.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { planMove, runMove } from "./project-move.js";

function space(/** @type {string} */ name, types = ["project", "chat", "note"]) {
  /** @type {Map<string, any>} */ const rows = new Map(); let n = 0;
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  const records = {
    create: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ data) => { const id = `${name}${++n}`; const r = { id, type, urn: `vyre://${name}/${type}/${id}`, version: 1, data: { ...data } }; rows.set(r.urn, r); return r; },
    get: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => rows.get(`vyre://${name}/${type}/${id}`) || null,
    update: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch) => { const u = `vyre://${name}/${type}/${id}`; const r = rows.get(u); const nr = { ...r, data: { ...r.data, ...patch }, version: r.version + 1 }; rows.set(u, nr); return nr; },
    remove: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => { rows.delete(`vyre://${name}/${type}/${id}`); },
    query: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ q) => ({ rows: [...rows.values()].filter(r => r.type === type && (!q.filter || JSON.stringify(r.data[q.filter.field]) === JSON.stringify(q.filter.value))) }),
    linked: async (/** @type {any} */ _c, /** @type {string} */ urn) => ({ truncated: false, rows: [...rows.values()].flatMap(r => Object.entries(r.data).filter(([, v]) => v && /** @type {any} */ (v).urn === urn).map(([field]) => ({ type: r.type, field, record: r }))) }),
  };
  const drive = {
    put: async (/** @type {any} */ _c, /** @type {string} */ p, /** @type {Uint8Array} */ b) => { files.set(p, b); return { version: 1 }; },
    get: async (/** @type {any} */ _c, /** @type {string} */ p) => { const b = files.get(p); if (!b) throw new Error("not found"); return { bytes: b }; },
    list: async (/** @type {any} */ _c, /** @type {string} */ prefix) => [...files].filter(([p]) => p.startsWith(prefix + "/")).map(([path, b]) => ({ path, size: b.length })),
  };
  return { space: name, records, drive, chain: { who: name }, types: async () => types.map(t => ({ name: t })), rows, files };
}
const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);

async function seed() {
  const a = space("A"), b = space("B");
  const proj = await a.records.create(null, "project", { name: "Rivera", slug: "rivera", status: "active", repo: "https://git/rivera", memory_scope: "project:rivera" });
  await a.records.update(null, "project", proj.id, { drive_path: `Projects/${proj.id}` });
  const chat = await a.records.create(null, "chat", { title: "Intake", project: { urn: proj.urn } });
  await a.records.create(null, "note", { title: "Called", chat: { urn: chat.urn }, project: { urn: proj.urn } });
  await a.drive.put(null, `Projects/${proj.id}/retainer.txt`, enc("signed"));
  await a.drive.put(null, `Projects/${proj.id}/chat/${chat.id}/dropped.txt`, enc("hello"));
  return { a, b, proj, chat };
}

test("a Project moves: new id and folder in the target, links rewritten, files intact, and the old Space keeps only a marker", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.deepEqual(plan.counts, { records: { chat: 1, note: 1 }, files: 2, bytes: 11, sealed_fields: 0 });
  assert.deepEqual(plan.blockers, []);
  const done = await runMove({ from: a, to: b, plan });
  const target = [...b.rows.values()].find(r => r.type === "project");
  assert.equal(target.urn, done.target);
  assert.notEqual(target.id, proj.id, "a NEW id");
  assert.equal(target.data.drive_path, `Projects/${target.id}`);
  assert.equal(target.data.moved_from, `A:${proj.urn}`);
  const chat = [...b.rows.values()].find(r => r.type === "chat");
  assert.equal(chat.data.project.urn, target.urn, "its link points at the new project");
  const note = [...b.rows.values()].find(r => r.type === "note");
  assert.equal(note.data.chat.urn, chat.urn, "and so do links between moved records");
  assert.equal(Buffer.from(b.files.get(`${target.data.drive_path}/retainer.txt`) || "").toString(), "signed");
  // the old Space keeps the marker only
  const marker = a.rows.get(proj.urn);
  assert.equal(marker.data.status, "moved");
  assert.equal(marker.data.moved_to, `B:${target.urn}`);
  assert.equal(marker.data.drive_path, null);
  assert.deepEqual([...a.rows.values()].filter(r => r.type !== "project"), [], "everything linked left with it");
  assert.equal(done.left_behind.length, 2, "files wait for an approved Drive delete when no cleanup is given");
});

test("a project that changed since it was approved is not moved", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  await a.records.create(null, "note", { title: "new", project: { urn: proj.urn } });
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /changed since it was approved/);
  assert.equal([...b.rows.values()].length, 0, "nothing was created");
});

test("a file that does not arrive intact stops the move before anything is removed", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const put = b.drive.put; b.drive.put = async (c, p, bytes) => put(c, p, p.endsWith("retainer.txt") ? enc("tampered") : bytes);
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /did not arrive intact/);
  assert.equal(a.rows.get(proj.urn).data.status, "active", "the source is untouched");
  assert.ok([...a.rows.values()].some(r => r.type === "chat"));
});

test("a type the target lacks, or sealed fields with no sealing port, block the move with a reason", async () => {
  const a = space("A"), b = space("B", ["project"]);
  const proj = await a.records.create(null, "project", { name: "R", slug: "r" });
  await a.records.create(null, "note", { title: "x", project: { urn: proj.urn } });
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.match(plan.blockers.join(), /no record type note/);
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /cannot run/);
  const c = space("C"), d = space("D");
  const p2 = await c.records.create(null, "project", { name: "S", slug: "s" });
  await c.records.create(null, "chat", { title: "x", project: { urn: p2.urn }, ssn: { sealed: "us-ssn", ref: "r", present: true } });
  const plan2 = await planMove({ from: c, to: d, project: p2.urn });
  assert.equal(plan2.counts.sealed_fields, 1);
  await assert.rejects(() => runMove({ from: c, to: d, plan: plan2 }), /sealed fields move only through the sealing process/);
  const resealed = /** @type {string[]} */ ([]);
  await runMove({ from: c, to: d, plan: plan2, ports: { reseal: async (/** @type {any} */ ref, /** @type {string} */ urn, /** @type {string} */ field) => { resealed.push(`${ref.ref}>${field}`); } } });
  assert.deepEqual(resealed, ["r>ssn"]);
});

test("a move that was interrupted resumes with the same state and does not create the project twice", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const state = {};
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports: { state, onStep: (/** @type {string} */ n) => { if (n === "files") throw new Error("crash"); } } }), /crash/);
  await runMove({ from: a, to: b, plan, ports: { state } });
  assert.equal([...b.rows.values()].filter(r => r.type === "project").length, 1);
  assert.equal([...b.rows.values()].filter(r => r.type === "chat").length, 1);
});

test("a type the target lacks is installed under the same approval and is part of the plan hash, not a blocker", async () => {
  const a = space("A"), b = space("B", ["project"]);
  const proj = await a.records.create(null, "project", { name: "R", slug: "r" });
  await a.records.create(null, "note", { title: "x", project: { urn: proj.urn } });
  const installed = /** @type {string[][]} */ ([]);
  /** @type {any} */ (b).install = async (/** @type {any} */ _c, /** @type {string[]} */ names) => { installed.push(names); };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.install, ["note"]);
  await runMove({ from: a, to: b, plan });
  assert.deepEqual(installed, [["note"]]);
});

test("the source files are removed under the mover's chain after the hashes match, once, and a failed removal resumes", async () => {
  const { a, b, proj } = await seed();
  /** @type {string[][]} */ const calls = [];
  let fail = true;
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ paths, /** @type {any} */ o) => {
    calls.push(paths); assert.equal(o.move_id, "mv1");
    if (fail) { fail = false; throw new Error("drive busy"); }
    for (const p of paths) a.files.delete(p);
    return { removed: paths.length };
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const ports = { move_id: "mv1", state: {} };
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports }), /drive busy/);
  assert.equal(a.files.size, 2, "nothing was lost when the removal failed");
  const done = await runMove({ from: a, to: b, plan, ports });
  assert.deepEqual(done.left_behind, []);
  assert.equal(a.files.size, 0, "the source files are gone");
  assert.equal(calls.length, 2);
  assert.equal([...b.rows.values()].filter(r => r.type === "project").length, 1, "the resume made nothing twice");
});
