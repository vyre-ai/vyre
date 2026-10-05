// @ts-check
// The hub's write rules without a daemon: the Drive folder marker is the CALLER's own write, so a caller who cannot write Drive cannot make a project and none is left half made; session folders
// are named from the title and the id and move with a rename.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHub } from "./hub.js";

/** A kernel stand-in: records in a map, a Drive that refuses a chain named "nodrive", and every moveFolder call recorded. */
function fake() {
  /** @type {Map<string, any>} */ const rows = new Map(); let n = 0;
  const moves = /** @type {string[][]} */ ([]);
  const kernel = {
    space: "spc_x", owner: "per_o", serviceChain: () => ({ who: "service" }),
    records: {
      create: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ data) => { const id = `id${++n}`; const r = { id, type, urn: `vyre://spc_x/${type}/${id}`, version: 1, data }; rows.set(id, r); return r; },
      query: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ q) => ({ rows: [...rows.values()].filter(r => r.type === type && (!q.filter || JSON.stringify(r.data[q.filter.field]) === JSON.stringify(q.filter.value))) }),
      get: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {string} */ id) => rows.get(id) || null,
      update: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {string} */ id, /** @type {any} */ patch) => { const r = rows.get(id); const nr = { ...r, data: { ...r.data, ...patch }, version: r.version + 1 }; rows.set(id, nr); return nr; },
      remove: async (/** @type {any} */ _c, /** @type {string} */ _t, /** @type {string} */ id) => { rows.delete(id); },
    },
    drive: {
      put: async (/** @type {any} */ by) => { if (by && by.who === "nodrive") throw Object.assign(new Error("not allowed"), { code: "not_found" }); return { version: 1 }; },
      moveFolder: async (/** @type {any} */ _by, /** @type {string} */ a, /** @type {string} */ b) => { moves.push([a, b]); return { moved: 0 }; },
    },
  };
  return { kernel, rows, moves };
}

test("a caller who cannot write Drive cannot make a project, and no record is left behind", async () => {
  const { kernel, rows } = fake();
  const hub = createHub({ kernel });
  await assert.rejects(() => hub.createProject({ who: "nodrive" }, { name: "Rivera" }), /not allowed/);
  assert.equal([...rows.values()].filter(r => r.type === "project").length, 0);
  const ok = await hub.createProject({ who: "person" }, { name: "Rivera" });
  assert.equal(ok.data.drive_path, `Projects/${ok.id}`, "the folder is named by the record's id");
});

test("a session's folders are named by its id: a rename moves nothing, and Move to project moves the two folders as the mover, aborting before any relink if one is refused", async () => {
  const { kernel, moves } = fake();
  const hub = createHub({ kernel });
  const a = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const b = await hub.createProject({ who: "p" }, { name: "Harlow" });
  const sess = await kernel.records.create(null, "session-summary", { title: "Welcome email", thread: "0f0e0d0c-0b0a-4908", project: { urn: a.urn }, drive: a.data.drive_path });
  assert.equal(hub.sessionFolder(sess), "0f0e0d0c-0b0a-4908");
  const renamed = await hub.renameSession(sess, "Engagement letter", "record", { who: "p" });
  assert.equal(renamed.data.title, "Engagement letter");
  const proj = await hub.renameProject(a, "Rivera Family", "record", { who: "p" });
  assert.equal(proj.data.name, "Rivera Family");
  assert.equal(proj.data.drive_path, a.data.drive_path, "a rename never changes the folder");
  assert.deepEqual(moves, [], "and moves nothing");
  const mover = { who: "mover" };
  await hub.moveSession(sess.data.thread, b.urn, mover);
  assert.deepEqual(moves, [[`${a.data.drive_path}/chat/0f0e0d0c-0b0a-4908`, `${b.data.drive_path}/chat/0f0e0d0c-0b0a-4908`], [`${a.data.drive_path}/made/0f0e0d0c-0b0a-4908`, `${b.data.drive_path}/made/0f0e0d0c-0b0a-4908`]]);
  assert.equal((await hub.sessionRecord(sess.data.thread)).data.drive, b.data.drive_path);
  await assert.rejects(() => hub.moveSession(sess.data.thread, a.urn), /moved by a person/);
});

test("when a file of the move is refused the session stays where it was", async () => {
  const { kernel } = fake();
  kernel.drive.moveFolder = async () => { throw Object.assign(new Error("that folder is not yours to move"), { code: "not_found" }); };
  const hub = createHub({ kernel });
  const a = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const b = await hub.createProject({ who: "p" }, { name: "Harlow" });
  await kernel.records.create(null, "session-summary", { title: "x", thread: "t9", project: { urn: a.urn }, drive: a.data.drive_path });
  await assert.rejects(() => hub.moveSession("t9", b.urn, { who: "m" }), /not yours/);
  assert.equal((await hub.sessionRecord("t9")).data.project.urn, a.urn);
});

test("a /rename inside Claude Code reaches the record: only a CHANGE in the transcript's name counts, and a stale one never overwrites a title set in Records", async () => {
  const { kernel } = fake();
  let name = "First";
  const hub = createHub({ kernel, call: async (/** @type {string} */ tool) => (tool === "recall.sessions" ? { data: [{ id: "t1", name }] } : { data: null }) });
  const p = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const rec = await kernel.records.create(null, "session-summary", { title: "First", thread: "t1", project: { urn: p.urn }, drive: p.data.drive_path });
  const title = async () => (await kernel.records.query(null, "session-summary", { filter: { field: "thread", op: "eq", value: "t1" } })).rows[0].data.title;
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "First", "the first look only records the name");
  name = "Engagement letter";
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "Engagement letter", "a /rename in the terminal reaches the record");
  await hub.renameSession(await hub.sessionRecord("t1"), "Set in Records", "record");
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "Set in Records", "the transcript's unchanged name does not overwrite it");
  void rec;
});
