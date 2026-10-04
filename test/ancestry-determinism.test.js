import "../scripts/mac-test-guard.mjs";
// @ts-check
// The ancestry measurement must give the same answer for the same caller, loaded or not (team-lead, 4 Oct): 50 concurrent CLI calls from plain processes, every one classified alike, while the box is busy.
// A call whose measurement fails or times out is "unknown" and is never a person; it must also not be a different answer on the next run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { setPeerHosting } from "../core/daemon/peer.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("50 concurrent CLI calls on a busy box are all classified the same", { timeout: 240_000, skip: process.platform === "win32" }, async t => {
  const root = tempHome(t);
  globalThis.__seen = [];
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who"] }, needs: { kernel: { actions: [] } } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, callers: ["cli", "mcp"], run: async (_i, meta) => {
      let kind = "none"; try { const c = await ctx.kernel.chain(meta); kind = c.hops.map(h => h.actor.kind).join(">"); } catch (e) { kind = "refused"; }
      globalThis.__seen.push(meta.caller + "|" + kind); return {};
    } });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "det-"));
  const js = path.join(dir, "c.mjs");
  fs.writeFileSync(js, `import http from "node:http";
const req = http.request({ socketPath: ${JSON.stringify(d.paths.socket)}, path: "/v1/tools/probe.who", method: "POST", headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "cli" } }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.on("error", () => process.exit(0)); req.end("{}");`);
  // load: busy loops, one per core
  const burners = Array.from({ length: Number(process.env.VYRE_DET_BURN || 6) }, () => spawn(process.execPath, ["-e", "const t=Date.now();while(Date.now()-t<60000){}"], { stdio: "ignore" }));
  t.after(() => burners.forEach(b => b.kill("SIGKILL")));
  setPeerHosting(true);
  try { await Promise.all(Array.from({ length: 50 }, () => new Promise(r => spawn(process.execPath, [js], { stdio: "ignore" }).on("close", r)))); } finally { setPeerHosting(false); }
  const counts = {}; for (const s of globalThis.__seen) counts[s] = (counts[s] || 0) + 1;
  if (process.env.VYRE_DET_SHOW) console.error("classes:", JSON.stringify(counts));
  assert.equal(globalThis.__seen.length, 50, "every call reached the tool as something: " + JSON.stringify(counts));
  assert.equal(Object.keys(counts).length, 1, "every call was classified the same: " + JSON.stringify(counts));
});
