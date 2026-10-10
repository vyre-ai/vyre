// @ts-check
// store.types() hands out one deep-frozen list until a type changes (every records query asks for it three or four times, and cloning all the types each time was most of an idle vyred's minute tick).
// A define or a remove must show at once, and a caller that tries to change the list must fail loudly instead of corrupting the cache.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "./memory.js";

const T = (/** @type {string} */ name) => ({ name, label: name, fields: [{ name: "title", kind: "text", label: "Title" }] });

test("types(): the same frozen list until a define, a change or a remove, and the new list shows the change at once", async () => {
  const s = createMemoryStore({});
  await s.define({ add_types: [T("note")] });
  const a = await s.types(), b = await s.types();
  assert.equal(a, b, "no change, the same list: nothing was cloned the second time");
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a[0]) && Object.isFrozen(a[0].fields[0]), "deep-frozen");
  await s.define({ add_types: [T("task")] });
  const c = await s.types();
  assert.notEqual(c, a);
  assert.deepEqual(c.map(t => t.name), ["note", "task"], "an added type shows at once");
  await s.define({ change_types: [{ ...T("note"), label: "Notes" }] });
  assert.equal((await s.types()).find(t => t.name === "note")?.label, "Notes", "a changed type shows at once");
  await s.define({ remove_types: ["task"] });
  assert.deepEqual((await s.types()).map(t => t.name), ["note"], "a removed type is gone at once");
  assert.equal(a[0].label, "note", "a list handed out earlier is a snapshot and is not changed under its holder");
});

test("types(): a caller that tries to change the list fails loudly, and the store's answer is not corrupted", async () => {
  const s = createMemoryStore({});
  await s.define({ add_types: [T("note")] });
  const list = await s.types();
  assert.throws(() => { "use strict"; /** @type {any} */ (list).push({ name: "evil" }); }, TypeError);
  assert.throws(() => { "use strict"; /** @type {any} */ (list[0]).label = "x"; }, TypeError);
  assert.deepEqual((await s.types()).map(t => t.name), ["note"]);
});
