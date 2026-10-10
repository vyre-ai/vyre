// @ts-check
// A module defining its core type again keeps the fields a Kit added (J1: the base Kit adds `stage` to the core Project, then work defines the core Project; the Twenty store refuses a define that drops a field).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { extending, defineExtending } from "./types-extend.js";

const CORE = { name: "project", fields: [{ name: "name", kind: "text" }, { name: "template_stage", kind: "text" }] };
const KIT = { name: "project", fields: [{ name: "name", kind: "text" }, { name: "stage", kind: "stage" }] };

/** A store that behaves like the Twenty one on this point: a define that leaves out a field it holds is refused. */
function store() {
  /** @type {Map<string, any>} */ const held = new Map();
  return {
    held,
    types: async () => [...held.values()],
    define: async (/** @type {any} */ d) => {
      for (const t of d.add_types) {
        const was = held.get(t.name);
        if (was) for (const f of was.fields) if (!t.fields.some((/** @type {any} */ x) => x.name === f.name)) throw Object.assign(new Error(`Field ${f.name} of ${t.name} was removed: removing a field is a migration, not a define`), { code: "unsupported" });
        held.set(t.name, t);
      }
    },
  };
}

test("the core type defined after a Kit added a field keeps the Kit's field, and the module's own fields are there", async () => {
  const s = store();
  await s.define({ add_types: [KIT] });
  await defineExtending(s, [CORE]);
  const names = s.held.get("project").fields.map((/** @type {any} */ f) => f.name);
  assert.deepEqual(names.sort(), ["name", "stage", "template_stage"]);
});

test("without the extension the same define is refused (the J1 failure)", async () => {
  const s = store();
  await s.define({ add_types: [KIT] });
  await assert.rejects(() => s.define({ add_types: [CORE] }), /Field stage of project was removed/);
});

test("a type the store lacks, and a type with nothing extra, come back as they were", () => {
  assert.deepEqual(extending([CORE], []), [CORE]);
  const same = { name: "project", fields: [...CORE.fields] };
  assert.equal(extending([same], [same])[0], same);
});

test("two modules starting together each extend what the other just defined: defines run one at a time per store (the J1 store_disagreed race)", async () => {
  const s = store();
  const slow = s.define;
  s.define = async (/** @type {any} */ d) => { await new Promise(r => setTimeout(r, 20)); return slow(d); };
  const A = { name: "chat-record", fields: [{ name: "title", kind: "text" }, { name: "a", kind: "text" }] };
  const B = { name: "chat-record", fields: [{ name: "title", kind: "text" }, { name: "b", kind: "text" }] };
  await Promise.all([defineExtending(s, [A]), defineExtending(s, [B])]);
  assert.deepEqual(s.held.get("chat-record").fields.map((/** @type {any} */ f) => f.name).sort(), ["a", "b", "title"]);
  const other = store();
  await Promise.all([defineExtending(s, [A]), defineExtending(other, [B])]);
  assert.ok(other.held.has("chat-record"), "another store is not held up by this one");
});
