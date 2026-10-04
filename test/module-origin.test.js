import "../scripts/mac-test-guard.mjs";
// @ts-check
// A module that relays a call never has to remember to say who it acts for: the registry's own ctx.call sets `meta.origin` from the call that is running (captureOrigin), and nothing a client sends is ever
// an origin. So a module relaying a model's call reaches `wantsMacs` (core/modules/federate.js) as acting for that model and gets the box's own rows, whatever its author wrote. Work started AFTER the call
// returns (a timer) has no running call, so it is the module's own: a module that stores work for later keeps ctx.origin() beside it and replays it with ctx.withOrigin (docs/MODULES.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const FEDERATE = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core", "modules", "federate.js")).href;

test("ctx.call carries the origin without the module doing anything; a deferred call has none; wantsMacs follows it", { timeout: 120_000, skip: process.platform === "win32" }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box" }));
  // `zzrelay.go` forgets everything: it never reads or passes an origin. `zzrelay.later` calls from a timer. `zzprobe.seen` reports what reached it.
  writeModule(path.join(root, "modules"), "zzrelay", { does: { tools: ["zzrelay.go", "zzrelay.two", "zzrelay.later"] }, needs: { tools: ["zzprobe.seen"] } }, `export default { async start(ctx) {
    ctx.tool("zzrelay.go", { input: { type: "object" }, callers: ["cli", "mcp", "module"], run: async () => (await ctx.call("zzprobe.seen", {})).data });
    ctx.tool("zzrelay.two", { input: { type: "object" }, callers: ["cli", "mcp", "module"], run: async () => (await Promise.all([ctx.call("zzrelay.go", {}), ctx.call("zzprobe.seen", {})])).map(r => r.data) });
    ctx.tool("zzrelay.later", { input: { type: "object" }, callers: ["cli", "mcp"], run: async () => { setTimeout(async () => { globalThis.__later = (await ctx.call("zzprobe.seen", {})).data; }, 20); return { started: true }; } });
    return {};
  } };`);
  writeModule(path.join(root, "modules"), "zzprobe", { does: { tools: ["zzprobe.seen"] }, needs: {} }, `import { wantsMacs } from ${JSON.stringify(FEDERATE)};
export default { async start(ctx) {
    ctx.tool("zzprobe.seen", { input: { type: "object" }, callers: ["cli", "mcp", "module"], run: async (_i, meta) => ({ caller: meta.caller, origin: meta.origin || null, macs: await wantsMacs(ctx, { machines: "all" }, meta.caller, meta) }) });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {string} */ caller) => d.registry.call(tool, {}, caller);
  const viaModel = /** @type {any} */ ((await call("zzrelay.go", "mcp:thread:t")).data);
  assert.equal(viaModel.caller, "module:zzrelay"); assert.equal(viaModel.origin, "mcp:thread:t", "a module that never mentions origin still relays it");
  assert.equal(viaModel.macs, false, "so a module relaying a model's call gets the box's own rows");
  const viaPerson = /** @type {any} */ ((await call("zzrelay.go", "cli")).data);
  assert.equal(viaPerson.origin, "cli"); assert.equal(viaPerson.macs, true, "and one acting for the person's cli gets the Macs'");
  const two = /** @type {any[]} */ ((await call("zzrelay.two", "mcp:thread:t")).data);
  assert.deepEqual(two.map(x => x.origin), ["mcp:thread:t", "mcp:thread:t"], "through two hops and Promise.all");
  globalThis.__later = null;
  await call("zzrelay.later", "mcp:thread:t");
  for (let i = 0; i < 100 && !globalThis.__later; i++) await new Promise(r => setTimeout(r, 50));
  const later = /** @type {any} */ (globalThis.__later);
  assert.ok(later, "the deferred call ran");
  assert.equal(later.origin, null, "work started after the call returned has no running call: it is the module's own, and says so");
});
