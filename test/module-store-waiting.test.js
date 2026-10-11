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

test("a real daemon whose record store cannot start: no module is failed, and the planner waits for the records", { timeout: 60_000 }, async t => {
  process.env.VYRE_STORE = "twenty";   // no room for a Twenty here, so the Space's store stays away
  t.after(() => { delete process.env.VYRE_STORE; });
  // the machine's own preflight would provision a real Twenty on a box that can run one (minutes, and it is another test's server); this test says the store cannot start, on any machine
  const recordsStore = { preflight: async () => ({ ok: false, reasons: ["Docker is not installed (the test says so)"], facts: {} }) };
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true, recordsStore });
  t.after(() => d.stop());
  const st = d.registry.status();
  assert.deepEqual(st.filter((/** @type {any} */ m) => m.state === "failed" || m.state === "invalid").map((/** @type {any} */ m) => m.name), [], "nothing fails the start while the store is away");
  const planner = st.find((/** @type {any} */ m) => m.name === "planner");
  assert.equal(planner.state, "running");
  assert.equal(planner.waiting, "records");
});
