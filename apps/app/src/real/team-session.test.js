import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createSharedSessions } from "./team-session.js";

/** A manual clock for the idle timer. */
const clock = () => { let n = 0; const pending = new Map(); return { set: (f, ms) => { pending.set(++n, { f, ms }); return n; }, clear: (t) => { pending.delete(t); }, fire: () => { for (const [k, v] of [...pending]) { pending.delete(k); v.f(); } }, count: () => pending.size }; };
const rig = (calls = async () => "ok") => {
  const opened = [], closed = [];
  const c = clock();
  const ss = createSharedSessions({ idleMs: 60_000, timers: c, open: async (space) => { const id = opened.length + 1; opened.push(space); return { call: (n, a) => calls(n, a, id), close: () => closed.push(id) }; } });
  return { ss, opened, closed, c };
};

test("a screen load (15 calls at once) opens ONE session for the Space and every call uses it; another Space has its own", async () => {
  const { ss, opened } = rig();
  await Promise.all(Array.from({ length: 15 }, (_, i) => ss.call("spc_aaaaaaaaaaaa", `records.list${i}`, [{}])));
  assert.deepEqual(opened, ["spc_aaaaaaaaaaaa"]);
  await ss.call("spc_bbbbbbbbbbbb", "records.me", []);
  assert.deepEqual(opened, ["spc_aaaaaaaaaaaa", "spc_bbbbbbbbbbbb"]);
});

test("after 60 s with nothing to do the session closes; the next call opens a new one; a call in flight keeps it open", async () => {
  const { ss, opened, closed, c } = rig();
  await ss.call("spc_aaaaaaaaaaaa", "x", []);
  c.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [1]);
  await ss.call("spc_aaaaaaaaaaaa", "x", []);
  assert.equal(opened.length, 2);
  let release; const slow = ss.call("spc_aaaaaaaaaaaa", "slow", []); 
  await ss.call("spc_aaaaaaaaaaaa", "y", []);
  c.fire();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [1, 2].slice(0, closed.length), "closed only when idle");
  await slow;
});

test("a door refusal (it has a code) keeps the session; a transport failure drops it and the next call opens a new one", async () => {
  let n = 0;
  const { ss, opened, closed } = rig(async () => { n++; if (n === 1) throw Object.assign(new Error("not yours"), { code: "not_allowed" }); if (n === 2) throw Object.assign(new Error("gone"), { code: "unreachable" }); return "ok"; });
  await assert.rejects(() => ss.call("spc_aaaaaaaaaaaa", "x", []), (e) => e.code === "not_allowed");
  assert.deepEqual([opened.length, closed.length], [1, 0], "a refusal leaves it");
  await assert.rejects(() => ss.call("spc_aaaaaaaaaaaa", "x", []), (e) => e.code === "unreachable");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [1]);
  assert.equal(await ss.call("spc_aaaaaaaaaaaa", "x", []), "ok");
  assert.equal(opened.length, 2);
});

test("an open that fails is not kept: the next call tries again; closeAll closes everything", async () => {
  let fail = true; const opened = [], closed = [];
  const ss = createSharedSessions({ open: async (s) => { if (fail) { fail = false; throw Object.assign(new Error("no"), { code: "unreachable" }); } opened.push(s); return { call: async () => "ok", close: () => closed.push(s) }; } });
  await assert.rejects(() => ss.call("spc_aaaaaaaaaaaa", "x", []));
  assert.equal(await ss.call("spc_aaaaaaaaaaaa", "x", []), "ok");
  await ss.call("spc_bbbbbbbbbbbb", "x", []);
  ss.closeAll();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed.sort(), ["spc_aaaaaaaaaaaa", "spc_bbbbbbbbbbbb"]);
  assert.equal(ss.size, 0);
});
