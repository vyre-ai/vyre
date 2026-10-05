// @ts-check
// The hub's write rules without a daemon: the Drive folder marker is the CALLER's own write, so a caller who cannot write Drive cannot make a project and none is left half made; session folders
// are named from the title and the id and move with a rename.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHub, folderName } from "./hub.js";

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
  assert.equal(ok.data.drive_path, "Projects/Rivera");
});

test("a session's folders are named from its title and id, and follow a rename and a move", async () => {
  const { kernel, moves } = fake();
  const hub = createHub({ kernel });
  const a = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const b = await hub.createProject({ who: "p" }, { name: "Harlow" });
  const sess = await kernel.records.create(null, "session-summary", { title: "Welcome email", thread: "0f0e0d0c-0b0a-4908", project: { urn: a.urn }, drive: a.data.drive_path });
  assert.equal(hub.sessionFolder(sess), "welcome-email-0f0e0d");
  const renamed = await hub.renameSession(sess, "Engagement letter", "record", { who: "p" });
  assert.equal(renamed.data.title, "Engagement letter");
  assert.deepEqual(moves.slice(0, 2), [["Projects/Rivera/chat/welcome-email-0f0e0d", "Projects/Rivera/chat/engagement-letter-0f0e0d"], ["Projects/Rivera/made/welcome-email-0f0e0d", "Projects/Rivera/made/engagement-letter-0f0e0d"]]);
  await hub.moveSession(sess.data.thread, b.urn, { who: "p" });
  assert.deepEqual(moves.slice(2), [["Projects/Rivera/chat/engagement-letter-0f0e0d", "Projects/Harlow/chat/engagement-letter-0f0e0d"], ["Projects/Rivera/made/engagement-letter-0f0e0d", "Projects/Harlow/made/engagement-letter-0f0e0d"]]);
});

test("folderName keeps a name usable as a Drive folder: no slashes, colons or control characters, no leading dots", () => {
  assert.equal(folderName("Rivera/Estate: 2026"), "Rivera Estate 2026");
  assert.equal(folderName("..hidden"), "hidden");
  assert.equal(folderName("///"), "Project");
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
