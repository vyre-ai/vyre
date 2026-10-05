// @ts-check
// The planner inside a real vyred: found among the core modules, reached through the real
// registry and its callers, and ringing on a fake clock into the event log every surface reads.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { seams } from "./index.js";

test("planner module: discovered, callers enforced by the registry, and a firing in the event log", async t => {
  // The kernel on, with this development tree counted as first party (the rule the daemon tests of records.* use): the planner keeps its records there.
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, planner: { timezone: "Asia/Karachi" } }));
  const clock = { t: Date.UTC(2026, 8, 24, 5) };
  /** @type {{ fn: () => void, at: number } | null} */
  let timer = null;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => (timer = { fn, at: clock.t + ms }), clearTimer: () => { timer = null; } });
  t.after(() => seams.delete(root));
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());

  const mod = d.registry.status().find(m => m.name === "planner");
  assert.equal(mod && mod.state, "running", JSON.stringify(mod));
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });

  const theirs = await as("mcp")("planner.add", { kind: "alarm", title: "Harlow Legal call", wall: "08:00" });
  assert.ok(!theirs.error, JSON.stringify(theirs.error));
  assert.equal((await as("mcp")("planner.settings", {})).error.code, "denied", "settings are the person's");
  const todo = await as("mcp")("planner.add", { kind: "todo", title: "Send Harlow Legal the draft" });
  assert.ok(!todo.error, JSON.stringify(todo.error));
  assert.equal((await as("cli")("planner.settings", {})).data.timezone, "Asia/Karachi");

  const a = (await as("cli")("planner.add", { kind: "alarm", title: "Northwind Bakery opens", wall: "07:00" })).data;
  assert.equal(a.at, Date.UTC(2026, 8, 25, 2));
  assert.ok(timer && timer.at - clock.t <= 6 * 3_600_000);
  // Wake the timer until the alarm is due, as the real clock would.
  for (let i = 0; i < 10 && clock.t < a.at; i++) { const x = /** @type {any} */ (timer); clock.t = x.at; x.fn(); }
  const fired = d.events.since(0, { type: "planner.fired" });
  assert.equal(fired.length, 1);
  assert.equal(fired[0].payload.item, a.id);
  const done = await as("deck")("planner.done", { firing: fired[0].payload.firing });
  assert.equal(done.data.firing.state, "acked");
  assert.deepEqual(d.events.since(0, { type: "planner.acked" }).map(e => e.payload.action), ["done"]);
  assert.deepEqual(d.events.since(0, { type: "planner.added" }).map(e => e.payload.kind), ["alarm", "todo", "alarm"]);
});
