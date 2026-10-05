// @ts-check
// The Cloud gate on a real daemon: on a Basic device (this computer is not a server) the Planner and the task tools answer that they need a Cloud space and list the Cloud spaces the person is in;
// on a server they work. The tier comes from the spaces module's own `spaces.tier`.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { forgetCloudGate } from "../../lib/cloud-gate.js";

async function daemon(/** @type {any} */ t, /** @type {"local" | "box"} */ role) {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-home", role, transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] }, planner: { timezone: "Asia/Karachi" } }));
  forgetCloudGate();
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => { d.stop(); forgetCloudGate(); });
  return { root, d, as: (/** @type {string} */ tool, /** @type {any} */ input = {}) => call(tool, input, { root, caller: "cli" }) };
}

test("cloud gate on a real daemon: a Basic device refuses Planner and Tasks in plain words, a server does not", async t => {
  const basic = await daemon(t, "local");
  const tier = await basic.as("spaces.tier", {});
  // spaces.tier is internal (modules only): a person's call does not reach it
  assert.ok(tier.error, "internal to modules");
  const add = await basic.as("planner.add", { kind: "reminder", title: "Call juno", wall: "18:00" });
  assert.equal(add.error && add.error.code, "needs_cloud", JSON.stringify(add));
  assert.equal(add.error.message, "Planner needs a Cloud space: join a team or set up My Cloud");
  assert.deepEqual(add.error.detail.spaces, [], "the person is in no Cloud space");
  assert.doesNotMatch(add.error.message, /\b(pro|server)\b/i);
  assert.equal((await basic.as("planner.list", {})).error.code, "needs_cloud");
  const task = await basic.as("tasks.list", {});
  assert.equal(task.error && task.error.code, "needs_cloud", JSON.stringify(task));
  assert.equal((await basic.as("planner.parse", { text: "alarm 7am" })).error, undefined, "reading words needs no space");
});

test("cloud gate on a real daemon: a server runs Planner and Tasks", async t => {
  const server = await daemon(t, "box");
  const add = await server.as("planner.add", { kind: "reminder", title: "Call juno", wall: "18:00" });
  assert.ok(!add.error, JSON.stringify(add.error));
  assert.ok(!(await server.as("tasks.list", {})).error);
});
