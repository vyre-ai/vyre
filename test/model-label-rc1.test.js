// @ts-check
// RC-1 (reviewer-2): a model's label carried a thread the client chose (`mcp:thread:<another project's thread>`), and modules that read the thread out of the label believed it. The daemon now builds a model's
// label from what it verified (a bound socket, a session key, an agent key) and drops anything else: with nothing verified the caller is the bare kind. Real daemon, real socket.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { request } from "../core/daemon/client.js";
import { modelLabel } from "../lib/caller.js";

test("modelLabel builds from the verified parts only", () => {
  assert.equal(modelLabel("mcp"), "mcp");
  assert.equal(modelLabel("mcp:thread:t2"), "mcp");
  assert.equal(modelLabel("harness:thread:t2"), "harness");
  assert.equal(modelLabel("mcp thread:t2 extra"), "mcp");
  assert.equal(modelLabel("mcp:thread:t2", { thread: "t1" }), "mcp:thread:t1");
  assert.equal(modelLabel("harness", { thread: "t1" }), "harness:thread:t1");
  assert.equal(modelLabel("mcp:thread:t2", { thread: "t1", agent: "kit" }), "mcp:agent:kit");
  assert.equal(modelLabel("cli"), null);
  assert.equal(modelLabel("mcpx"), null);
});

test("over the real socket a client-sent thread label arrives as the bare kind", async t => {
  const root = tempHome(t);
  globalThis.__rc1 = [];
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who"] }, needs: { kernel: { actions: [] } } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, callers: ["mcp", "harness"], run: async (_i, meta) => { globalThis.__rc1.push({ caller: meta.caller, thread: meta.thread || null }); return {}; } });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  for (const label of ["mcp:thread:t-other", "harness:thread:t-other", "mcp", "mcp thread:t-other", "mcp:thread:"]) {
    const r = await request("POST", "/v1/tools/probe.who", {}, { root, caller: label });
    assert.ok(!r.error, label + " " + JSON.stringify(r));
  }
  assert.deepEqual(globalThis.__rc1.map((/** @type {any} */ w) => w.caller), ["mcp", "harness", "mcp", "mcp", "mcp"]);
  assert.ok(globalThis.__rc1.every((/** @type {any} */ w) => w.thread === null));
});
