import "../scripts/mac-test-guard.mjs";
// The lead's conditions on MH-1: (1) `standalone` is the standalone Chrome runtime's own flag: sent by a client or a module through the registry it never reaches a tool; (2) the standalone runtime refuses
// to start while a vyred is running for the same person, so the two never serve the extension with different rules.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { createRuntime, vyredRunning } from "../local/hands-chrome-mac/standalone/runtime.js";

test("meta.standalone is stripped from every call through the registry, client or module", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zflag", { does: { tools: [{ name: "zflag.seen", effect: "read", reach: "anyone" }, { name: "zflag.relay", effect: "read", reach: "anyone" }] }, needs: { tools: [] } },
    `export default { async start(ctx) {
      ctx.tool("zflag.seen", { effect: "read", callers: ["cli", "mcp", "module"], input: { type: "object", properties: {} }, run: async (i, meta) => ({ standalone: meta.standalone === true }) });
      ctx.tool("zflag.relay", { effect: "read", callers: ["cli", "mcp"], input: { type: "object", properties: {} }, run: async () => (await ctx.call("zflag.seen", {}, { standalone: true })).data });
      return {}; } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  assert.deepEqual((await d.registry.call("zflag.seen", {}, "mcp", { standalone: true })).data, { standalone: false });
  assert.deepEqual((await d.registry.call("zflag.seen", {}, "cli", { standalone: true })).data, { standalone: false });
  assert.deepEqual((await d.registry.call("zflag.seen", {}, "module:other", { standalone: true })).data, { standalone: false });
  assert.deepEqual((await d.registry.call("zflag.relay", {}, "mcp", {})).data, { standalone: false });
});

test("the standalone runtime refuses to start while a vyred is running, and says why in plain words", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const old = process.env.VYRE_HOME; process.env.VYRE_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = old; });
  assert.equal(vyredRunning(), null);
  fs.writeFileSync(path.join(home, "vyred.pid"), String(process.pid));
  assert.equal(vyredRunning(), process.pid);
  await assert.rejects(createRuntime({ dataDir: path.join(home, "data") }), err => err.code === "vyred_running" && /Vyre is running on this computer/.test(err.message) && /vyre down/.test(err.message));
  fs.writeFileSync(path.join(home, "vyred.pid"), "999999");
  assert.equal(vyredRunning(), null, "a stale pid file is no vyred");
});
