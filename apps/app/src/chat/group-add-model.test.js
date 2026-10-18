// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { addToGroup } from "./group-add-model.js";

/** A fake work.chat.add-people: threads without a ring come back as missing_rings. @param {string[]} threads */
const fake = (threads) => {
  /** @type {any[]} */ const calls = [];
  const call = async (/** @type {string} */ t, /** @type {any} */ i) => {
    calls.push(i);
    const have = Object.keys(i.rings || {});
    const missing = threads.filter((x) => !have.includes(x));
    return { missing_rings: missing, failed: [], done: !missing.length };
  };
  return { call, calls };
};

test("a group gets every thread: ask, make the ring each missing thread needs, ask again", async () => {
  const f = fake(["t1", "t2"]);
  const made = /** @type {string[]} */ ([]);
  const r = await addToGroup(f.call, "t1", ["per_c"], async (thread) => { made.push(thread); return { ring: "ring-" + thread }; });
  assert.equal(r, null);
  assert.deepEqual(made.sort(), ["t1", "t2"]);
  assert.deepEqual(f.calls[1].rings, { t1: "ring-t1", t2: "ring-t2" });
});

test("a device that cannot make a ring says why and stops", async () => {
  const f = fake(["t1", "t2"]);
  const r = await addToGroup(f.call, "t1", ["per_c"], async () => ({ say: "Some devices can't open private chats yet." }));
  assert.equal(r, "Some devices can't open private chats yet.");
  assert.equal(f.calls.length, 1);
});

test("threads that keep failing end the loop with a line, not forever", async () => {
  const call = async () => ({ missing_rings: ["t1"], failed: [], done: false });
  const r = await addToGroup(call, "t1", ["per_c"], async () => ({ ring: "r" }));
  assert.match(String(r), /could not be added to every thread/);
});

test("a thread that failed on the server is named in the line", async () => {
  const call = async () => ({ missing_rings: [], failed: [{ thread: "t2", error: "denied" }], done: false });
  assert.match(String(await addToGroup(call, "t1", ["per_c"], async () => ({ ring: "r" }))), /denied/);
});
