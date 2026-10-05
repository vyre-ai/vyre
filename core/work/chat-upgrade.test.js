// @ts-check
// Personal to My Cloud: the chats move with their ids, under the person's own chain, in one go; a chat that is working blocks the plan; one that cannot move is named and the rest still do.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { planUpgrade, runUpgrade } from "./chat-upgrade.js";

function space(/** @type {string} */ name) {
  /** @type {Map<string, any>} */ const rows = new Map(); let n = 0;
  /** @type {Map<string, Uint8Array>} */ const files = new Map();
  const records = {
    create: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ data) => { const id = `${name}${++n}`; const r = { id, type, urn: `vyre://${name}/${type}/${id}`, version: 1, data: { ...data } }; rows.set(r.urn, r); return r; },
    update: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id, /** @type {any} */ patch) => { const u = `vyre://${name}/${type}/${id}`; const r = rows.get(u); const nr = { ...r, data: { ...r.data, ...patch }, version: r.version + 1 }; rows.set(u, nr); return nr; },
    remove: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {string} */ id) => { rows.delete(`vyre://${name}/${type}/${id}`); },
    query: async (/** @type {any} */ _c, /** @type {string} */ type, /** @type {any} */ q) => ({ rows: [...rows.values()].filter(r => r.type === type && (!q.filter || r.data[q.filter.field] === q.filter.value)) }),
  };
  return { space: name, records, chain: { hops: [{ actor: { kind: "person", id: "per_me" } }] }, rows, files, drive: /** @type {any} */ ({}) };
}

async function seed() {
  const a = space("P"), b = space("C");
  const proj = await a.records.create(null, "project", { name: "General", slug: "general", drive_path: "Projects/gp" });
  const mk = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ status, /** @type {string} */ people) => a.records.create(null, "chat-record", { title, chat: id, project: { urn: proj.urn }, people, agents: "kit", status, drive: "Projects/gp", location: `Projects/gp/chat/${id}/`, started: "2026-10-01T00:00:00.000Z", last_active: "2026-10-02T00:00:00.000Z" });
  const c1 = await mk("chat_one", "Docket", "idle", "per_me"), c2 = await mk("chat_two", "Taxes", "idle", "per_me,per_gone");
  a.files.set("Projects/gp/chat/chat_one/a.txt", new TextEncoder().encode("hello"));
  /** @type {any} */ (a.drive).survey = async (/** @type {any} */ _c, /** @type {string} */ f) => (f.includes("chat_one") && f.includes("/chat/") ? { files: 1, bytes: 5 } : { files: 0, bytes: 0 });
  /** @type {any} */ (a.drive).inventory = async () => [{ path: "Projects/gp/chat/chat_one/a.txt", size: 5, sha256: "h", chat: true }];
  /** @type {string[]} */ const removed = [];
  /** @type {any} */ (a.drive).removeMoved = async (/** @type {any} */ _c, /** @type {string[]} */ p) => { removed.push(...p); return { removed: p.length }; };
  /** @type {any[]} */ const carried = [];
  /** @type {any} */ (a).carry = async (/** @type {any[]} */ e) => { carried.push(...e); return e.map(x => ({ path: x.path, dest: x.dest, sha256: x.sha256 })); };
  /** @type {any[]} */ const made = [];
  /** @type {any} */ (b).members = { roleOf: (/** @type {any} */ x) => (x.id === "per_me" ? "owner" : null) };
  /** @type {any} */ (b).chats = {
    create: async (/** @type {any} */ _c, /** @type {any} */ o) => { if (o.id === "chat_bad") throw new Error("no room"); const c = { id: o.id, people: ["per_me", ...o.people], assistants: [] }; made.push(c); return c; },
    change: async (/** @type {any} */ _c, /** @type {string} */ id, /** @type {any} */ ch) => { const c = made.find(x => x.id === id); for (const x of ch.add_assistants || []) throw Object.assign(new Error("an assistant in a chat belongs to the Space"), { code: "bad_input" }); return { ...c }; },
  };
  return { a, b, c1, c2, carried, removed, made };
}

test("the plan counts chats, files and bytes, and a chat that is working blocks it", async () => {
  const { a, c1, c2 } = await seed();
  const rows = [c1, c2];
  const plan = await planUpgrade({ from: a, rows });
  assert.deepEqual(plan.counts, { chats: 2, files: 1, bytes: 5 });
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.chats, ["chat_one", "chat_two"]);
  const busy = await planUpgrade({ from: a, rows: [{ ...c1, data: { ...c1.data, status: "working" } }] });
  assert.match(busy.blockers.join(), /Docket" is working/);
});

test("the chats move with their ids under General in the target, files sealed under the same ids, people who are no member there and agents that are missing listed as former, and the source emptied", async () => {
  const { a, b, c1, c2, carried, removed } = await seed();
  const out = await runUpgrade({ from: a, to: b, rows: [c1, c2], ports: { move_id: "up1" } });
  assert.deepEqual([out.moved, out.files, out.left], [2, 1, []]);
  const there = [...b.rows.values()].filter(r => r.type === "chat-record").sort((x, y) => x.data.chat.localeCompare(y.data.chat));
  assert.deepEqual(there.map(r => r.data.chat), ["chat_one", "chat_two"], "the ids are kept");
  assert.equal(there[0].data.title, "Docket");
  assert.equal(there[1].data.people, "per_me");
  assert.deepEqual(there[1].data.former.split(",").sort(), ["kit", "per_gone"]);
  const general = [...b.rows.values()].find(r => r.type === "project");
  assert.equal(general.data.slug, "general");
  assert.equal(there[0].data.drive, general.data.drive_path);
  assert.deepEqual(carried.map(e => e.dest), [`${general.data.drive_path}/chat/chat_one/a.txt`]);
  assert.deepEqual(removed, ["Projects/gp/chat/chat_one/a.txt"]);
  assert.equal([...a.rows.values()].filter(r => r.type === "chat-record").length, 0, "the source holds no chat any more");
  // run again: nothing is made twice
  const again = await runUpgrade({ from: a, to: b, rows: [], ports: {} });
  assert.equal(again.moved, 0);
});

test("a chat that cannot move is named, stays in the source, and does not stop the others", async () => {
  const { a, b, c1 } = await seed();
  const bad = await a.records.create(null, "chat-record", { title: "Broken", chat: "chat_bad", people: "per_me", agents: "", status: "idle", drive: "Projects/gp" });
  const out = await runUpgrade({ from: a, to: b, rows: [bad, c1], ports: { move_id: "up2" } });
  assert.equal(out.moved, 1);
  assert.deepEqual(out.left.map(l => l.chat), ["chat_bad"]);
  assert.match(out.left[0].why, /no room/);
  assert.ok([...a.rows.values()].some(r => r.type === "chat-record" && r.data.chat === "chat_bad"), "it is still in the source");
});
