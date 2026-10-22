// @ts-check
// A module that needs the Space's records must not FAIL the start because the record store is still starting. After an update the store takes minutes; the updater of the version before reads
// `vyre modules` and rolls the update back when a listed module is anything but running or off. So such a module is "waiting": it reports running with a note, its tools answer in the store's words,
// and it starts for real when the store joins. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { discover, Registry } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../kernel/bus.js";
import { start } from "../core/daemon/index.js";
import { tempHome, present, writeModule } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("a module whose start finds the record store away is waiting, not failed; its tools say so; it starts when the store joins, and a module that requires it follows", async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  globalThis.__storeUp = false;
  t.after(() => { delete globalThis.__storeUp; });
  writeModule(root, "needsrec", { does: { reads: [], tools: [{ name: "needsrec.list", effect: "read", reach: "anyone" }] } }, `
    export default { async start(ctx) {
      if (!globalThis.__storeUp) throw Object.assign(new Error("the record store for this space is not available yet: starting Records (12 s so far)"), { name: "StoreError", code: "unavailable" });
      ctx.tool("needsrec.list", { effect: "read", input: { type: "object" }, run: async () => ({ rows: [] }) }); return {};
    } };`);
  writeModule(root, "after", { requires: ["needsrec"], does: { reads: [], tools: [{ name: "after.ping", effect: "read", reach: "anyone" }] } }, `
    export default { async start(ctx) { ctx.tool("after.ping", { effect: "read", input: { type: "object" }, run: async () => ({ pong: true }) }); return {}; } };`);
  // `unavailable` for a reason that is not the store (no way to reach a paired server yet) is a failure, not a wait
  writeModule(root, "nolink", { does: { reads: [], tools: [{ name: "nolink.x", effect: "read", reach: "anyone" }] } }, `export default { async start() { throw Object.assign(new Error("no way to reach a paired server yet"), { code: "unavailable" }); } };`);
  writeModule(root, "broken", { does: { reads: [], tools: [{ name: "broken.x", effect: "read", reach: "anyone" }] } }, `export default { async start() { throw new Error("a real bug"); } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {} });
  await reg.start([...discover([root])], { role: "local" });
  const row = (/** @type {string} */ n) => reg.status().find((/** @type {any} */ m) => m.name === n);
  assert.equal(row("needsrec").state, "running", "waiting for the records reports running (the updater reads this)");
  assert.equal(row("needsrec").waiting, "records");
  assert.equal(row("after").state, "running", "a module that requires it waits too");
  assert.equal(row("after").waiting, "records");
  assert.equal(row("broken").state, "failed", "a real failure is still a failure");
  assert.equal(row("nolink").state, "failed", "an `unavailable` that is not the store's own refusal is a failure too, never shown as running");
  assert.equal(row("nolink").waiting, undefined);
  const early = await reg.call("needsrec.list", {}, "cli", {});
  assert.equal(early.error?.code, "unavailable");
  assert.match(early.error?.message || "", /waiting for the records.*starting Records/, "the tool answers in the store's words");

  globalThis.__storeUp = true;
  await reg.startStoreWaiting();
  assert.equal(row("needsrec").waiting, undefined, "the store joined: it runs for real");
  assert.deepEqual((await reg.call("needsrec.list", {}, "cli", {})).data, { rows: [] });
  assert.deepEqual((await reg.call("after.ping", {}, "cli", {})).data, { pong: true }, "and the module that requires it started after it");
  assert.equal(row("after").waiting, undefined);
});

test("a real daemon with VYRE_STORE=twenty starts on the Vyre store: the planner runs and is not waiting, and the old value is said once", { timeout: 60_000 }, async t => {
  process.env.VYRE_STORE = "twenty";
  t.after(() => { delete process.env.VYRE_STORE; });
  /** @type {string[]} */ const lines = [];
  const d = await start({ root: tempHome(t), presence: present, log: (/** @type {any} */ m) => lines.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const st = d.registry.status();
  assert.deepEqual(st.filter((/** @type {any} */ m) => m.state === "failed" || m.state === "invalid").map((/** @type {any} */ m) => m.name), [], "nothing fails the start");
  const planner = st.find((/** @type {any} */ m) => m.name === "planner");
  assert.equal(planner.state, "running");
  assert.equal(planner.waiting, undefined);
  assert.equal(lines.filter(l => l === "records: Twenty is gone; this Space starts on the Vyre store, empty").length, 1);
});

test("a module whose start meets the store's 'still starting' as the kernel passes it on (a KernelError with the store's words) is waiting, not failed; and it is tried again by itself, with no join event", { timeout: 30_000 }, async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  globalThis.__tries = 0;
  t.after(() => { delete globalThis.__tries; });
  // what the planner sees on a normal first install: the store accepted the module's types, then its first query waits out the store's bound and is refused in the store's words, under the kernel's own error name
  writeModule(root, "slowtypes", { does: { reads: [], tools: [{ name: "slowtypes.list", effect: "read", reach: "anyone" }] } }, `
    export default { async start(ctx) {
      if (++globalThis.__tries < 3) throw Object.assign(new Error("the record store is still starting: preparing its record types (80 seconds so far)"), { name: "KernelError", code: "unavailable" });
      ctx.tool("slowtypes.list", { effect: "read", input: { type: "object" }, run: async () => ({ rows: [] }) }); return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {}, waitRetryMs: 40 });
  t.after(() => reg.stop());
  await reg.start([...discover([root])], { role: "local" });
  const row = () => reg.status().find((/** @type {any} */ m) => m.name === "slowtypes");
  assert.equal(row().state, "running", "the store's own words under the kernel's name are a wait, not a failure");
  assert.equal(row().waiting, "records");
  const early = await reg.call("slowtypes.list", {}, "cli", {});
  assert.match(early.error?.message || "", /waiting for the records.*still starting/, "its tools answer in the store's words meanwhile");
  for (let i = 0; i < 100 && row().waiting; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(row().waiting, undefined, "it started by itself, with nobody calling startStoreWaiting");
  assert.equal(globalThis.__tries, 3, "and was started no more times than it needed");
  assert.deepEqual((await reg.call("slowtypes.list", {}, "cli", {})).data, { rows: [] });
});

test("a real daemon with VYRE_STORE=twenty answers planner.list at once on the Vyre store, and says the old value once", { timeout: 60_000 }, async t => {
  process.env.VYRE_STORE = "twenty";
  t.after(() => { delete process.env.VYRE_STORE; });
  /** @type {string[]} */ const lines = [];
  const d = await start({ root: tempHome(t), presence: present, log: (/** @type {any} */ m) => lines.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const planner = () => d.registry.status().find((/** @type {any} */ m) => m.name === "planner");
  assert.deepEqual(d.registry.status().filter((/** @type {any} */ m) => m.state === "failed" || m.state === "invalid").map((/** @type {any} */ m) => m.name), []);
  assert.equal(planner().state, "running");
  assert.equal(planner().waiting, undefined);
  assert.equal(lines.filter(l => l === "records: Twenty is gone; this Space starts on the Vyre store, empty").length, 1);
  const late = await d.registry.call("planner.list", {}, "cli", {});
  assert.ok(!late.error, "its tools answer: " + JSON.stringify(late.error));
});

test("a server restarted with VYRE_STORE=twenty still rings a stored reminder once, and the planner is not waiting", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const a = await start({ root, presence: present, log: () => {}, kernel: true });
  const at = new Date(Date.now() + 4000).toISOString();
  const added = await a.registry.call("planner.add", { text: "call Dana", kind: "reminder", at }, "cli", {});
  assert.ok(!added.error, JSON.stringify(added.error));
  const id = added.data.id;
  await a.stop();
  process.env.VYRE_STORE = "twenty";
  t.after(() => { delete process.env.VYRE_STORE; });
  /** @type {string[]} */ const lines = [];
  const d = await start({ root, presence: present, log: (/** @type {any} */ m) => lines.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const planner = () => d.registry.status().find((/** @type {any} */ m) => m.name === "planner");
  assert.equal(planner().state, "running");
  assert.equal(planner().waiting, undefined);
  assert.ok(lines.includes("records: Twenty is gone; this Space starts on the Vyre store, empty"));
  let rings = 0;
  for (let i = 0; i < 40 && rings < 1; i++) { await new Promise(r => setTimeout(r, 250)); const g = await d.registry.call("planner.get", { item: id }, "cli", {}); rings = (g.data && g.data.firings ? g.data.firings.length : 0); }
  await new Promise(r => setTimeout(r, 1500));
  const g = await d.registry.call("planner.get", { item: id }, "cli", {});
  assert.equal(g.data.firings.length, 1, "the stored reminder rang once, and not again: " + JSON.stringify(g.data && g.data.firings));
});

test("the retry of a waiting module does not start it while the store has not joined (it would only sit in the store's hold); it starts it the moment the store is there", { timeout: 30_000 }, async t => {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  globalThis.__tries2 = 0;
  t.after(() => { delete globalThis.__tries2; });
  writeModule(root, "held", { does: { reads: [], tools: [{ name: "held.list", effect: "read", reach: "anyone" }] } }, `
    export default { async start(ctx) {
      if (++globalThis.__tries2 < 2) throw Object.assign(new Error("the record store is still starting: getting ready (3 seconds so far)"), { name: "KernelError", code: "unavailable" });
      ctx.tool("held.list", { effect: "read", input: { type: "object" }, run: async () => ({ rows: [] }) }); return {};
    } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  let attached = false;
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, paths: { root: home }, log: () => {}, waitRetryMs: 30, storeAttached: () => attached });
  t.after(() => reg.stop());
  await reg.start([...discover([root])], { role: "local" });
  const row = () => reg.status().find((/** @type {any} */ m) => m.name === "held");
  assert.equal(row().waiting, "records");
  await new Promise(r => setTimeout(r, 400));   // several retry rounds go by with the store away
  assert.equal(globalThis.__tries2, 1, "the timer did not start it while the store was away");
  attached = true;
  for (let i = 0; i < 100 && row().waiting; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(row().waiting, undefined, "and it started by itself once the store was there");
  assert.equal(globalThis.__tries2, 2);
});

test("a join that arrives while a retry run is going is not lost: the run goes round once more", async t => {
  const { startWaiting } = await import("../core/modules/store-waiting.js");
  let starts = 0;
  /** @type {() => void} */ let release = () => {};
  const rec = { state: "waiting", waitsForStore: true, manifest: { name: "m" }, dir: "/x" };
  const reg = /** @type {any} */ ({ modules: new Map([["m", rec]]), tools: new Map(), deps: {},
    startOne: async () => { starts++; if (starts === 1) await new Promise(r => { release = /** @type {any} */ (r); }); else rec.state = "running"; } });
  const first = startWaiting(reg);
  await new Promise(r => setTimeout(r, 20));
  const second = startWaiting(reg);   // the store joined while the first run was inside the module's start
  release();
  await Promise.all([first, second]);
  assert.equal(starts, 2, "the module was started again after the join");
  assert.equal(rec.state, "running");
  void t;
});
