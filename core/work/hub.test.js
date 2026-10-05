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
      moveFolders: async (/** @type {any} */ _by, /** @type {[string, string][]} */ pairs) => { for (const p of pairs) moves.push(p); return { moved: 0 }; },
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

const CHAT_ID = "chat_0f0e0d0c-0b0a-4908";
const chatRow = (/** @type {any} */ proj, /** @type {string} */ id = CHAT_ID, /** @type {string} */ title = "Welcome email") => ({ title, chat: id, project: { urn: proj.urn }, people: "per_o", agents: "", status: "idle", drive: proj.data.drive_path, location: `${proj.data.drive_path}/chat/${id}/` });

test("a chat's folders are named by its id: a rename moves nothing, and Move to project moves the two folders as the mover, aborting before any relink if one is refused", async () => {
  const { kernel, moves } = fake();
  const hub = createHub({ kernel });
  const a = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const b = await hub.createProject({ who: "p" }, { name: "Harlow" });
  const chat = await kernel.records.create(null, "chat-record", chatRow(a));
  const renamed = await hub.renameChat(chat, "Engagement letter", "record", { who: "p" });
  assert.equal(renamed.data.title, "Engagement letter");
  const proj = await hub.renameProject(a, "Rivera Family", "record", { who: "p" });
  assert.equal(proj.data.name, "Rivera Family");
  assert.equal(proj.data.drive_path, a.data.drive_path, "a rename never changes the folder");
  assert.deepEqual(moves, [], "and moves nothing");
  const mover = { who: "mover" };
  await hub.moveChat(CHAT_ID, b.urn, mover);
  assert.deepEqual(moves, [[`${a.data.drive_path}/chat/${CHAT_ID}`, `${b.data.drive_path}/chat/${CHAT_ID}`], [`${a.data.drive_path}/made/${CHAT_ID}`, `${b.data.drive_path}/made/${CHAT_ID}`]]);
  const moved = await hub.chatRecord(CHAT_ID);
  assert.deepEqual([moved.data.drive, moved.data.location], [b.data.drive_path, `${b.data.drive_path}/chat/${CHAT_ID}/`]);
  await assert.rejects(() => hub.moveChat(CHAT_ID, a.urn), /moved by a person/);
});

test("when a file of the move is refused the chat stays where it was", async () => {
  const { kernel } = fake();
  kernel.drive.moveFolders = async () => { throw Object.assign(new Error("that folder is not yours to move"), { code: "not_found" }); };
  const hub = createHub({ kernel });
  const a = await hub.createProject({ who: "p" }, { name: "Rivera" });
  const b = await hub.createProject({ who: "p" }, { name: "Harlow" });
  await kernel.records.create(null, "chat-record", chatRow(a, "chat_t9", "x"));
  await assert.rejects(() => hub.moveChat("chat_t9", b.urn, { who: "m" }), /not yours/);
  assert.equal((await hub.chatRecord("chat_t9")).data.project.urn, a.urn);
});

test("a /rename inside Claude Code reaches the chat's title: only a CHANGE in the transcript's name counts, and a stale one never overwrites a title set in Records", async () => {
  const { kernel } = fake();
  let name = "First";
  const hub = createHub({ kernel, call: async (/** @type {string} */ tool) => (tool === "recall.sessions" ? { data: [{ id: "t1", name }] } : tool === "threads.chat-of" ? { data: { chat: "chat_t1" } } : tool === "threads.of-chat" ? { data: { runs: [] } } : { data: null }) });
  const p = await hub.createProject({ who: "p" }, { name: "Rivera" });
  await kernel.records.create(null, "chat-record", chatRow(p, "chat_t1", "First"));
  const title = async () => (await hub.chatRecord("chat_t1")).data.title;
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "First", "the first look only records the name");
  name = "Engagement letter";
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "Engagement letter", "a /rename in the terminal reaches the record");
  await hub.renameChat(await hub.chatRecord("chat_t1"), "Set in Records", "record");
  await hub.onTurn({ session: "t1" });
  assert.equal(await title(), "Set in Records", "the transcript's unchanged name does not overwrite it");
});

test("the kernel's chat.created and chat.changed make and mirror the record; a run's start fills the title and takes a chat out of General", async () => {
  const { kernel } = fake();
  const hub = createHub({ kernel, call: async (/** @type {string} */ tool) => (tool === "projects.list" ? { data: { projects: [{ slug: "rivera", name: "Rivera" }] } } : { data: null }) });
  const general = await hub.generalProject();
  await hub.onChatCreated({ data: { chat: { id: "chat_c1", people: ["per_o"], assistants: [] } } });
  let rec = await hub.chatRecord("chat_c1");
  assert.deepEqual([rec.data.title, rec.data.project.urn, rec.data.people, rec.data.agents, rec.data.status], ["New chat", general.urn, "per_o", "", "idle"]);
  assert.equal(rec.data.location, `${general.data.drive_path}/chat/chat_c1/`);
  await hub.onChatChanged({ data: { id: "chat_c1", people: ["per_o", "per_b"], assistants: ["kit"] } });
  rec = await hub.chatRecord("chat_c1");
  assert.deepEqual([rec.data.people, rec.data.agents], ["per_o,per_b", "kit"], "the mirror follows the kernel's list");
  await hub.onStarted({ chat: "chat_c1", name: "Docket check", project: "rivera" });
  rec = await hub.chatRecord("chat_c1");
  const rivera = await hub.projectOf("rivera");
  assert.deepEqual([rec.data.title, rec.data.status, rec.data.project.urn], ["Docket check", "working", rivera.urn]);
  assert.equal(rec.data.location, `${rivera.data.drive_path}/chat/chat_c1/`);
  // a start that comes before the kernel's own event makes the record too, and the event fills in the rest
  await hub.onStarted({ chat: "chat_c2", name: "Early" });
  await hub.onChatCreated({ data: { chat: { id: "chat_c2", people: ["per_o"], assistants: ["kit"] } } });
  assert.equal((await hub.chatRecord("chat_c2")).data.agents, "kit");
  assert.equal((await kernel.records.query(null, "chat-record", {})).rows.filter((/** @type {any} */ r) => r.data.chat === "chat_c2").length, 1, "one record per chat");
});
