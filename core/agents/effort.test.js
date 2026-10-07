// @ts-check
// agents: an agent's Effort (the Deck's agent page) is kept, listed, and checked. Temp home only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";

test("an agent's effort is saved by agents.update, shown by agents.list, and only sessions.effort's values pass", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const c = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "local");
  const made = await c("agents.create", { name: "kit", kind: "agent", projects: [], effort: "low" });
  assert.equal(made.error, undefined, JSON.stringify(made));
  assert.equal(made.data.effort, "low");
  const r = await c("agents.update", { name: "kit", model: "sonnet", effort: "high" });
  assert.equal(r.error, undefined, JSON.stringify(r));
  const kit = (await c("agents.list")).data.find((/** @type {any} */ a) => a.name === "kit");
  assert.deepEqual([kit.model, kit.effort], ["sonnet", "high"]);
  // Another change leaves the effort alone.
  await c("agents.update", { name: "kit", instructions: "Bake the Northwind Bakery report" });
  assert.equal((await c("agents.list")).data.find((/** @type {any} */ a) => a.name === "kit").effort, "high");
  assert.equal((await c("agents.update", { name: "kit", effort: "extreme" })).error.code, "bad_input");
});
