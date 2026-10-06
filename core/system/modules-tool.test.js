// @ts-check
// system.modules: what the app reads to draw a module's Now card: the running modules and the tools they named as now:<tool> in shows.deck.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

test("system.modules lists the running modules with their now: tools, for the person's own surface only", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  writeModule(path.join(root, "modules"), "demo", { vyre: "1", description: "A demo card.", does: { tools: [{ name: "demo.card", reach: "anyone", summary: "today's card" }] }, shows: { deck: ["now:demo.card", "settings"] } },
    `export default { async start(ctx) { ctx.tool("demo.card", { input: { type: "object" }, run: async () => ({ title: "Demo", detail: "all good" }) }); return { async stop() {} }; } };`);
  const d = await start({ presence: present, root, firstPartyRoots: [path.join(root, "modules")], log: () => {} });
  t.after(() => d.stop());
  const r = await call("system.modules", {}, { root, caller: "cli" });
  assert.ok(r.data, JSON.stringify(r));
  const demo = r.data.modules.find((/** @type {any} */ m) => m.name === "demo");
  assert.deepEqual([demo.state, demo.now], ["running", ["demo.card"]]);
  assert.ok(r.data.modules.some((/** @type {any} */ m) => m.name === "system"));
  assert.ok((await call("system.modules", {}, { root, caller: "mcp" })).error, "an assistant's label does not get the module list");
});
