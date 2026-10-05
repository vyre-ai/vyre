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

test("the memory room moves between the files and the marker: offered, sealed, imported with a receipt, and forgotten only after", async () => {
  const { a, b, proj } = await seed();
  /** @type {string[]} */ const order = [];
  const memory = {
    offer: async (/** @type {any} */ i) => { order.push("offer"); assert.match(i.target, /^vyre:\/\/B\/project\//); return { to_key: "k" }; },
    export: async (/** @type {any} */ i) => { order.push("export"); assert.equal(i.to_key, "k"); assert.ok(a.rows.get(proj.urn).data.drive_path, "the source project is still whole"); return { package: "sealed" }; },
    import: async (/** @type {any} */ i) => { order.push("import"); assert.equal(i.package, "sealed"); return { digest: "d", counts: { writes: 3 } }; },
    forget: async (/** @type {any} */ i) => { order.push("forget"); assert.equal(i.receipt.digest, "d"); return { forgotten: { writes: 3 } }; },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const done = await runMove({ from: a, to: b, plan, ports: { memory } });
  assert.deepEqual(order, ["offer", "export", "import", "forget"]);
  assert.deepEqual(done.moved.memory, { writes: 3 });
});

test("the Work engine's lines move with the files: exported, imported through the id map, forgotten only after, with the records they were filed under", async () => {
  const { a, b, proj } = await seed();
  /** @type {string[]} */ const order = [];
  const know = {
    export: async (/** @type {any} */ i) => { order.push("export"); assert.ok(i.records.includes(proj.urn)); return { rows: [{ record: proj.urn }] }; },
    import: async (/** @type {any} */ i) => { order.push("import"); assert.match(i.map[proj.urn], /^vyre:\/\/B\/project\//); assert.equal(i.from_space, "A"); return { digest: "k", count: 1 }; },
    forget: async (/** @type {any} */ i) => { order.push("forget"); assert.equal(i.receipt.digest, "k"); return { forgotten: 1 }; },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const done = await runMove({ from: a, to: b, plan, ports: { know } });
  assert.deepEqual(order, ["export", "import", "forget"]);
  assert.equal(done.moved.know, 1);
});

test("a project's chat folders are carried sealed by the Space service: counted without reading, listed by the move's event, hash-checked on what arrives, and removed after", async () => {
  const { a, b, proj } = await seed();
  const chatPath = [...a.files.keys()].find(p => p.includes("/chat/"));
  const bytes = a.files.get(chatPath);
  /** @type {any[]} */ const carried = []; /** @type {string[][]} */ const removed = [];
  /** @type {any} */ (a.drive).survey = async () => ({ files: 1, bytes: bytes.length });
  /** @type {any} */ (a.drive).inventory = async (/** @type {any} */ _c, /** @type {string} */ folder, /** @type {any} */ o) => { assert.equal(o.move_id, "mv9"); return [{ path: chatPath, size: bytes.length, sha256: "ct-hash", chat: true }]; };
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ paths) => { removed.push(paths); for (const p of paths) a.files.delete(p); return { removed: paths.length }; };
  // without a carry the plan says so and nothing runs
  const blocked = await planMove({ from: a, to: b, project: proj.urn });
  assert.match(blocked.blockers.join(), /cannot carry a chat's sealed files/);
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ entries) => { carried.push(...entries); return entries.map(e => ({ path: e.path, dest: e.dest, sha256: "ct-hash" })); };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.counts.chat_files, 1);
  assert.equal(plan.files.length, 1, "the mover's own file list no longer holds the chat file");
  const done = await runMove({ from: a, to: b, plan, ports: { move_id: "mv9" } });
  assert.equal(carried.length, 1);
  assert.match(carried[0].dest, /^Projects\/[^/]+\/chat\//);
  assert.ok(removed.flat().includes(chatPath), "the chat file is removed with the rest");
  assert.deepEqual(done.left_behind, []);
});

test("a chat file that does not arrive with the hash it left with stops the move before anything is removed", async () => {
  const { a, b, proj } = await seed();
  const chatPath = [...a.files.keys()].find(p => p.includes("/chat/"));
  /** @type {any} */ (a.drive).survey = async () => ({ files: 1, bytes: 5 });
  /** @type {any} */ (a.drive).inventory = async () => [{ path: chatPath, size: 5, sha256: "ct-hash", chat: true }];
  /** @type {any} */ (a.drive).removeMoved = async () => { throw new Error("must not be called"); };
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ entries) => entries.map(e => ({ path: e.path, dest: e.dest, sha256: "tampered" }));
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports: { move_id: "mv9" } }), /did not arrive intact/);
  assert.equal(a.files.has(chatPath), true);
  assert.ok([...a.rows.values()].some(r => r.type === "chat"), "the source records are still there");
});

test("MV-2: a retry with no saved state finds the project an earlier attempt made and does not make a second", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports: { onStep: (/** @type {string} */ n) => { if (n === "links") throw new Error("crash"); } } }), /crash/);
  assert.equal([...b.rows.values()].filter(r => r.type === "project").length, 1);
  // the retry has no state (a new process): the pointer back on the project is how it finds its way
  /** @type {any} */ const again = await runMove({ from: a, to: b, plan, ports: {} }).catch(e => e);
  assert.equal([...b.rows.values()].filter(r => r.type === "project").length, 1, "still one project in the target");
  void again;
});

test("MV-2: a saved state resumes a move without copying a record twice", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  /** @type {any} */ let saved = null;
  const save = async (/** @type {any} */ st) => { saved = JSON.parse(JSON.stringify(st)); };
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports: { save, onStep: (/** @type {string} */ n) => { if (n === "files") throw new Error("crash"); } } }), /crash/);
  await runMove({ from: a, to: b, plan, ports: { state: saved, save } });
  assert.equal([...b.rows.values()].filter(r => r.type === "chat").length, 1);
  assert.equal([...b.rows.values()].filter(r => r.type === "project").length, 1);
});

test("MV-3: a copied record is read back and compared by content before the source records go", async () => {
  const { a, b, proj } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const create = b.records.create;
  /** @type {any} */ (b.records).create = async (/** @type {any} */ c, /** @type {string} */ type, /** @type {any} */ data) => create(c, type, type === "chat" ? { ...data, title: "tampered" } : data);
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /did not arrive intact/);
  assert.ok([...a.rows.values()].some(r => r.type === "chat"), "the source records are still there");
});

test("MV-4: a record edited after the approval is not the record that was approved, and a listed path outside the project's folder is refused", async () => {
  const { a, b, proj, chat } = await seed();
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  await a.records.update(null, "chat", chat.id, { title: "Edited after approval" });
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /changed since/);
  const s2 = await seed();
  const plan2 = await planMove({ from: s2.a, to: s2.b, project: s2.proj.urn });
  plan2.files = ["Projects/elsewhere/secret.txt"];
  await assert.rejects(() => runMove({ from: s2.a, to: s2.b, plan: plan2 }), /outside the project's folder/);
});

test("a memory room that changed during the move is carried again and forgotten against the new receipt", async () => {
  const { a, b, proj } = await seed();
  /** @type {string[]} */ const order = [];
  let first = true;
  const memory = {
    offer: async () => { order.push("offer"); return { to_key: "k" }; },
    export: async () => { order.push("export"); return { package: "p" }; },
    import: async () => { order.push("import"); return { digest: first ? "old" : "new", counts: { writes: 1 } }; },
    forget: async (/** @type {any} */ i) => { order.push(`forget:${i.receipt.digest}`); if (first) { first = false; throw Object.assign(new Error("changed since export"), { code: "conflict" }); } return { forgotten: { writes: 1 } }; },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  await runMove({ from: a, to: b, plan, ports: { memory } });
  assert.deepEqual(order, ["offer", "export", "import", "forget:old", "offer", "export", "import", "forget:new"]);
});

test("the plan carries every file's content hash from the Drive's own record, and a file edited after the approval stops the move", async () => {
  const { a, b, proj } = await seed();
  /** @type {any} */ (a.drive).stat = async (/** @type {any} */ _c, /** @type {string} */ p) => { const bytes = a.files.get(p); return { size: bytes.length, sha256: Buffer.from(bytes).toString("hex") }; };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.equal(Object.keys(plan.hashes).length, plan.files.length);
  assert.ok(Object.values(plan.hashes).every(h => typeof h === "string" && h.length > 0));
  const again = await planMove({ from: a, to: b, project: proj.urn });
  assert.equal(again.hash, plan.hash, "the same contents, the same hash");
  const f = plan.files[0];
  a.files.set(f, enc("edited after approval"));
  await assert.rejects(() => runMove({ from: a, to: b, plan }), /changed since/);
});

test("the Work lines: a crash between import and forget resumes and completes, and a line written in between is carried again", async () => {
  const { a, b, proj } = await seed();
  /** @type {string[]} */ const order = [];
  let late = false;
  const know = {
    export: async () => { order.push("export"); return { rows: [{ record: proj.urn }] }; },
    import: async () => { order.push("import"); return { digest: late ? "new" : "old", count: 1 }; },
    forget: async (/** @type {any} */ i) => { order.push(`forget:${i.receipt.digest}`); if (!late) { late = true; throw Object.assign(new Error("changed since export"), { code: "conflict" }); } return { forgotten: 1 }; },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  /** @type {any} */ let saved = null;
  const save = async (/** @type {any} */ st) => { saved = JSON.parse(JSON.stringify(st)); };
  // crash right after the import, before the forget
  await assert.rejects(() => runMove({ from: a, to: b, plan, ports: { know, save, onStep: (/** @type {string} */ n) => { if (n === "marker") throw new Error("crash"); } } }), /crash/);
  assert.deepEqual(order, ["export", "import"]);
  assert.equal(saved.know_receipt.digest, "old", "the receipt was saved");
  // the resume forgets against it, meets a line written meanwhile, carries again and forgets once more
  const done = await runMove({ from: a, to: b, plan, ports: { know, save, state: saved } });
  assert.deepEqual(order, ["export", "import", "forget:old", "export", "import", "forget:new"]);
  assert.equal(done.moved.know, 1);
});

test("a chat moves with its project: made again in the target under a NEW id as the mover's act, people who are members and agents that exist stay, the rest are former, and its sealed files land under the new id", async () => {
  const a = space("A", ["project", "chat-record"]), b = space("B", ["project", "chat-record"]);
  const proj = await a.records.create(null, "project", { name: "Rivera", slug: "rivera", status: "active", memory_scope: "project:rivera" });
  await a.records.update(null, "project", proj.id, { drive_path: `Projects/${proj.id}` });
  await a.records.create(null, "chat-record", { title: "Intake", chat: "chat_old1", project: { urn: proj.urn }, people: "per_a,per_b,per_mover", agents: "kit,ghost", status: "idle" });
  const chatPath = `Projects/${proj.id}/chat/chat_old1/dropped.txt`;
  a.files.set(chatPath, enc("hello"));
  /** @type {any[]} */ const carried = [];
  /** @type {any} */ (a.drive).survey = async () => ({ files: 1, bytes: 5 });
  /** @type {any} */ (a.drive).inventory = async () => [{ path: chatPath, size: 5, sha256: "ct", chat: true }];
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ paths) => { for (const p of paths) a.files.delete(p); return { removed: paths.length }; };
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ entries) => { carried.push(...entries); return entries.map(e => ({ path: e.path, dest: e.dest, sha256: "ct" })); };
  // the target Space: per_a and the mover are members; kit exists there, ghost does not
  /** @type {any} */ const made = [];
  /** @type {any} */ (b).members = { roleOf: (/** @type {any} */ x) => (["per_a", "per_mover"].includes(x.id) ? "member" : null) };
  /** @type {any} */ (b).chain = { who: "B", hops: [{ actor: { kind: "person", id: "per_mover" } }] };
  /** @type {any} */ (b).chats = {
    create: async (/** @type {any} */ _c, /** @type {any} */ o) => { const c = { id: "chat_new1", people: ["per_mover", ...o.people], assistants: [...o.assistants] }; made.push(c); return c; },
    change: async (/** @type {any} */ _c, /** @type {string} */ id, /** @type {any} */ ch) => {
      const c = made[0];
      for (const x of ch.add_assistants || []) { if (x !== "kit") throw Object.assign(new Error("an assistant in a chat belongs to the Space"), { code: "bad_input" }); c.assistants.push(x); }
      for (const x of ch.remove_people || []) c.people = c.people.filter((/** @type {string} */ p) => p !== x);
      return { ...c };
    },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  assert.deepEqual(plan.blockers, []);
  const done = await runMove({ from: a, to: b, plan, ports: { move_id: "mvc" } });
  assert.ok(done.target);
  const rec = [...b.rows.values()].find(r => r.type === "chat-record");
  assert.equal(rec.data.chat, "chat_new1", "a new chat id in the target");
  assert.equal(rec.data.title, "Intake");
  assert.deepEqual(rec.data.people.split(",").sort(), ["per_a", "per_mover"], "per_a and the mover (who was in it) stay; per_b is no member there");
  assert.equal(rec.data.agents, "kit");
  assert.deepEqual(rec.data.former.split(",").sort(), ["ghost", "per_b"]);
  assert.ok(rec.data.location.endsWith("/chat/chat_new1/") && rec.data.drive === `Projects/${done.target.split("/").pop()}`);
  assert.match(carried[0].dest, /\/chat\/chat_new1\/dropped\.txt$/, "the files go under the new id");
});

test("a chat nobody in the target was part of stays in the source Space: the mover never gains a chat they were not in, its record and files stay, and the move names it", async () => {
  const a = space("A", ["project", "chat-record"]), b = space("B", ["project", "chat-record"]);
  const proj = await a.records.create(null, "project", { name: "Rivera", slug: "rivera", status: "active", memory_scope: "project:rivera" });
  await a.records.update(null, "project", proj.id, { drive_path: `Projects/${proj.id}` });
  await a.records.create(null, "chat-record", { title: "Private", chat: "chat_priv", project: { urn: proj.urn }, people: "per_x,per_y", agents: "", status: "idle" });
  await a.records.create(null, "chat-record", { title: "Shared", chat: "chat_ok", project: { urn: proj.urn }, people: "per_a,per_mover", agents: "", status: "idle" });
  // a chat of members of the target that the mover was NOT in: it stays too, because the move's carry refuses the files of a chat the mover is not in, and a record never moves without its files
  await a.records.create(null, "chat-record", { title: "Others only", chat: "chat_oth", project: { urn: proj.urn }, people: "per_a", agents: "", status: "idle" });
  a.files.set(`Projects/${proj.id}/chat/chat_oth/o.txt`, enc("not yours"));
  const privPath = `Projects/${proj.id}/chat/chat_priv/secret.txt`, okPath = `Projects/${proj.id}/chat/chat_ok/ok.txt`;
  a.files.set(privPath, enc("secret")); a.files.set(okPath, enc("fine"));
  /** @type {any[]} */ const carried = []; /** @type {string[]} */ const removed = [];
  const othPath = `Projects/${proj.id}/chat/chat_oth/o.txt`;
  /** @type {any} */ (a.drive).survey = async () => ({ files: 3, bytes: 19 });
  /** @type {any} */ (a.drive).inventory = async () => [{ path: privPath, size: 6, sha256: "h1", chat: true }, { path: okPath, size: 4, sha256: "h2", chat: true }, { path: othPath, size: 9, sha256: "h3", chat: true }];
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ paths) => { removed.push(...paths); for (const p of paths) a.files.delete(p); return { removed: paths.length }; };
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ entries) => { carried.push(...entries); return entries.map(e => ({ path: e.path, dest: e.dest, sha256: e.sha256 })); };
  /** @type {any[]} */ const made = [];
  /** @type {any} */ (b).members = { roleOf: (/** @type {any} */ x) => (["per_a", "per_mover"].includes(x.id) ? "member" : null) };
  /** @type {any} */ (b).chain = { who: "B", hops: [{ actor: { kind: "person", id: "per_mover" } }] };
  /** @type {any} */ (b).chats = {
    create: async (/** @type {any} */ _c, /** @type {any} */ o) => { const c = { id: `chat_new${made.length + 1}`, people: ["per_mover", ...o.people], assistants: [] }; made.push(c); return c; },
    change: async (/** @type {any} */ _c, /** @type {string} */ id, /** @type {any} */ ch) => { const c = made.find(x => x.id === id); for (const x of ch.remove_people || []) c.people = c.people.filter((/** @type {string} */ p) => p !== x); return { ...c }; },
  };
  const plan = await planMove({ from: a, to: b, project: proj.urn });
  const done = await runMove({ from: a, to: b, plan, ports: { move_id: "mvp" } });
  assert.equal(made.length, 1, "only the chat someone in the target was part of is made again");
  assert.deepEqual([...b.rows.values()].filter(r => r.type === "chat-record").map(r => r.data.title), ["Shared"]);
  assert.deepEqual([...made[0].people].sort(), ["per_a", "per_mover"], "the mover was in it, so they stay in it");
  assert.ok([...a.rows.values()].some(r => r.type === "chat-record" && r.data.title === "Private"), "the private chat's record stays in the source");
  assert.ok(a.files.has(privPath) && !removed.includes(privPath), "and its files");
  assert.deepEqual(carried.map(e => e.path), [okPath]);
  assert.deepEqual(done.chats_left_behind.map(/** @param {any} x */ x => x.chat).sort(), ["chat_oth", "chat_priv"], "the private chat and the one the mover was not in both stay");
  assert.ok(a.files.has(othPath) && !removed.includes(othPath), "and the files of the chat the mover was not in");
});


test("the carry's two answer shapes are read alike, and a carry that skips the files of a chat that was to move stops the move before anything is removed", async () => {
  const { a, b, proj } = await seed();
  const chatPath = [...a.files.keys()].find(p => p.includes("/chat/"));
  /** @type {any} */ (a.drive).survey = async () => ({ files: 1, bytes: 5 });
  /** @type {any} */ (a.drive).inventory = async () => [{ path: chatPath, size: 5, sha256: "h", chat: true }];
  /** @type {string[]} */ const removed = [];
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ p) => { removed.push(...p); return { removed: p.length }; };
  // network-2's shape: { carried, skipped }
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ e) => ({ carried: e.map(x => ({ dest: x.dest, sha256: x.sha256 })), skipped: [] });
  const ok = await runMove({ from: a, to: b, plan: await planMove({ from: a, to: b, project: proj.urn }), ports: { move_id: "mvs1" } });
  assert.ok(ok.target);
  // a chat whose files the carry skipped, though it was to move: stop, remove nothing
  const s2 = await seed();
  const p2 = [...s2.a.files.keys()].find(p => p.includes("/chat/"));
  /** @type {any} */ (s2.a.drive).survey = async () => ({ files: 1, bytes: 5 });
  /** @type {any} */ (s2.a.drive).inventory = async () => [{ path: p2, size: 5, sha256: "h", chat: true }];
  /** @type {any} */ (s2.a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ p) => { removed.push(...p); return { removed: p.length }; };
  const oldChat = [...s2.a.rows.values()].find(r => r.type === "chat");
  /** @type {any} */ (s2.a).carry = async () => ({ carried: [], skipped: [{ path: p2, chat: oldChat.id }] });
  removed.length = 0;
  await assert.rejects(() => runMove({ from: s2.a, to: s2.b, plan: await planMove({ from: s2.a, to: s2.b, project: s2.proj.urn }), ports: { move_id: "mvs2" } }), /** @param {any} e */ e => e.code === "verify_failed" && /skipped the files of a chat/.test(e.message));
  assert.deepEqual(removed, [], "nothing was removed from the old Space");
});
