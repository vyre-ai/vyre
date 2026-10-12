import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createStoreRoute } from "./store-route.js";
import { TOOLS } from "../store-core/gateway-adapter.js";
import { MEMBER_ROWS } from "./member-routes.generated.js";

/** Every name the Store calls (store-core/gateway-adapter.js TOOLS). */
const STORE_NAMES = Object.values(TOOLS);
const rig = (/** @type {string | null} */ joined) => {
  const seen = /** @type {string[]} */ ([]);
  const wired = new Set(MEMBER_ROWS);
  const r = createStoreRoute({
    joinedSpace: async () => joined,
    door: async (n) => { seen.push(`door:${n}`); return { ok: n }; },
    wired: (n) => wired.has(n),
    notYet: "Doing this in the team is the owner's for now.", fail: (e) => Object.assign(new Error(e.message), { code: e.code }),
    plain: { read: async (n) => { seen.push(`plain-read:${n}`); return { ok: n }; }, write: async (n) => { seen.push(`plain-write:${n}`); return { ok: n }; } },
  });
  return { r, seen };
};

test("with no joined team (her own home, the owner's Space, All spaces) every name the Store uses takes today's call and send path, and never the door", async () => {
  const { r, seen } = rig(null);
  for (const n of STORE_NAMES) { await r.read(n, {}); await r.write(n, {}, {}); }
  assert.equal(seen.filter((s) => s.startsWith("door:")).length, 0);
  assert.deepEqual(seen.filter((s) => s.startsWith("plain-read:")).map((s) => s.slice(11)), STORE_NAMES);
  assert.deepEqual(seen.filter((s) => s.startsWith("plain-write:")).map((s) => s.slice(12)), STORE_NAMES);
});

test("with a joined team named, a name the door has a row for goes to the door; a name it has none for is refused in words and never reaches her own home", async () => {
  const { r, seen } = rig("spc_abcdefghijkl");
  const ROWS = STORE_NAMES.filter((n) => MEMBER_ROWS.includes(n));
  const NONE = STORE_NAMES.filter((n) => !MEMBER_ROWS.includes(n));
  assert.ok(ROWS.includes("records.list") && ROWS.includes("records.get") && ROWS.includes("records.events") && ROWS.includes("tasks.list"), "the Store's reads have rows");
  for (const n of ROWS) await r.read(n, {});
  assert.deepEqual(seen, ROWS.map((n) => `door:${n}`));
  seen.length = 0;
  for (const n of NONE) await assert.rejects(() => r.read(n, {}), (e) => e.code === "not_allowed" && /owner's for now/.test(e.message), n);
  for (const n of NONE) await assert.rejects(() => r.write(n, {}, {}), (e) => e.code === "not_allowed", n);
  assert.deepEqual(seen, [], "nothing went anywhere");
  assert.ok(NONE.length > 0, "records.sees-as, seal-put, reveal, define and tasks.decide are the owner's for now");
});

test("store-link.ts: the Store's rpc is the routed one, events stay the plain stream, and the routing decision is made in store-route.js alone", () => {
  const src = fs.readFileSync(new URL("../api/store-link.ts", import.meta.url), "utf8");
  assert.match(src, /const routed = createStoreRoute\(\{/);
  assert.match(src, /export const boxRpc = \{ read: routed\.read, write: routed\.write, events \}/);
  assert.match(src, /plain: \{ read: plainRpc\.read, write: plainRpc\.write \}/);
  assert.equal((src.match(/joinedHere\(/g) || []).length, 2, "the route asks once and the event poll asks once");
});

test("a member's Store write that the door refuses reaches the screen in the door's own words, one per class: a set-up type, a kept type, a task that is not hers, the owner's-for-now name", async () => {
  const { createGatewayStore, storeError } = await import("../store-core/gateway-adapter.js");
  const words = {
    "records.define": null,
    "records.create": "Your role cannot add a Matter in this Space: ask the owner.",
    "records.update": "That record is kept by the Flows module: only the owner changes it.",
    "tasks.move": "That task is Ben's: only Ben or the owner moves it.",
  };
  const r = createStoreRoute({
    joinedSpace: async () => "spc_aaaaaaaaaaaa", wired: (n) => MEMBER_ROWS.includes(n), notYet: "Doing this in the team is the owner's for now.", fail: storeError,
    door: async (n) => { if (n === "records.types") return [{ name: "matter", fields: [] }]; throw Object.assign(new Error(words[n]), { code: "not_allowed" }); },
    plain: { read: async () => { throw new Error("her own home was asked"); }, write: async () => { throw new Error("her own home was asked"); } },
  });
  const store = createGatewayStore({ rpc: /** @type {any} */ (r) });
  const said = async (f) => { try { await f(); return null; } catch (e) { return String(e.message); } };
  assert.equal(await said(() => store.create("matter", { title: "x" })), words["records.create"]);
  assert.equal(await said(() => store.update("vyre://spc_aaaaaaaaaaaa/matter/m1", { title: "y" }, 1)), words["records.update"]);
  assert.equal(await said(() => store.move("t1", "done")), words["tasks.move"]);
  assert.equal(await said(() => store.addField("matter", { label: "Court", kind: "text" })), "Doing this in the team is the owner's for now.", "a set-up type change is the owner's for now");
  for (const m of [words["records.create"], words["records.update"], words["tasks.move"]]) assert.ok(!/something went wrong|did not work/i.test(m));
});

/** A route over a scripted door: `plan` says what each call does ("ok", {code}, "lost"); the keys the door saw are kept. */
const idemRig = (plan, clock = { t: 1000 }) => {
  const seen = [];
  let n = 0;
  const r = createStoreRoute({
    joinedSpace: async () => "spc_aaaaaaaaaaaa", wired: () => true, notYet: "x", fail: (e) => Object.assign(new Error(e.message), { code: e.code }), now: () => clock.t, newKey: () => `key${++n}`,
    door: async (name, input) => {
      seen.push({ name, ...input });
      const step = plan.shift();
      if (step === "lost") throw Object.assign(new Error("no answer"), { code: "timeout" });
      if (step && step.code) throw Object.assign(new Error(step.message || "refused"), { code: step.code });
      return step && step.value !== undefined ? step.value : { ok: name };
    },
    plain: { read: async () => { throw new Error("home"); }, write: async () => { throw new Error("home"); } },
  });
  return { r, seen, clock };
};
const KEYS = (/** @type {any[]} */ seen) => seen.map((s) => s.idem);

test("a create whose reply was LOST carries the same key when she presses again; after any answer the key is spent", async () => {
  const { r, seen, clock } = idemRig(["lost", "ok", "ok", { code: "not_allowed" }, "ok"]);
  const input = { type: "contact", data: { name: "Jane" } };
  await assert.rejects(() => r.write("records.create", input, {}), (e) => e.code === "timeout");
  await r.write("records.create", { data: { name: "Jane" }, type: "contact" }, {});           // pressed again, keys in another order: the same call
  assert.deepEqual(KEYS(seen), ["key1", "key1"], "the repeat after a lost reply reuses the key");
  await r.write("records.create", input, {});                                                  // she makes a second identical one on purpose: it got an answer before, so a fresh key
  assert.equal(seen[2].idem, "key2");
  await assert.rejects(() => r.write("records.create", input, {}), (e) => e.code === "not_allowed");
  await r.write("records.create", input, {});
  assert.deepEqual(KEYS(seen), ["key1", "key1", "key2", "key3", "key4"], "a refusal also spends the key");
  void clock;
});

test("two deliberate identical creates that both got answers carry two different keys; a lost key is forgotten after 60 s and for a different input", async () => {
  const a = idemRig(["ok", "ok"]);
  await a.r.write("tasks.request", { task: { title: "Blank", doer: "x" } }, {}); await a.r.write("tasks.request", { task: { title: "Blank", doer: "x" } }, {});
  assert.deepEqual(KEYS(a.seen), ["key1", "key2"]);
  const b = idemRig(["lost", "ok"]);
  await assert.rejects(() => b.r.write("records.create", { type: "t", data: { a: 1 } }, {}));
  b.clock.t += 61_000;
  await b.r.write("records.create", { type: "t", data: { a: 1 } }, {});
  assert.deepEqual(KEYS(b.seen), ["key1", "key2"], "after 60 s the lost one is let go");
  const c = idemRig(["lost", "ok"]);
  await assert.rejects(() => c.r.write("records.create", { type: "t", data: { a: 1 } }, {}));
  await c.r.write("records.create", { type: "t", data: { a: 2 } }, {});
  assert.deepEqual(KEYS(c.seen), ["key1", "key2"], "a different input is a different call");
  const d = idemRig(["ok"]);
  await d.r.write("records.update", { urn: "u", patch: {}, base_version: 1 }, {});
  assert.equal(d.seen[0].idem, undefined, "only a create and a task request carry a key");
});

test("a repeat of a move or a hand-in that the first press already did is not an error: the task as it stands comes back; any other refusal is shown", async () => {
  const done = { id: "t1", state: "done" };
  const a = idemRig([{ code: "bad_input", message: "a task that is done cannot go to done" }, { value: { task: done } }]);
  assert.deepEqual(await a.r.write("tasks.move", { id: "t1", to: "done" }, {}), { task: done });
  assert.equal(a.seen[1].name, "tasks.get");
  const b = idemRig([{ code: "bad_input", message: "a task that is done cannot go to working" }]);
  await assert.rejects(() => b.r.write("tasks.move", { id: "t1", to: "working" }, {}), /cannot go to working/, "a real refusal is shown");
  const c = idemRig([{ code: "bad_input", message: "a task that is needs_check cannot go to done" }, { value: { task: { id: "t1", state: "needs_check" } } }]);
  assert.equal((await c.r.write("tasks.submit", { id: "t1", evidence: {} }, {})).task.state, "needs_check", "a hand-in already in review");
});
