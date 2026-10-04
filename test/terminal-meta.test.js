import "../scripts/mac-test-guard.mjs";
// The terminal login the daemon measured for a socket call (core/daemon atTerminal) must reach the tool as meta.terminal: signin.ask pins a sign-in to it. The registry took the option out of
// the call and used it only for the presence check, so every real `vyre signin` answered no_terminal while the unit tests (which call the module's tools directly) passed.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";

test("meta.terminal is what the router measured, and a tool sees nothing when none was", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "zterm", { does: { tools: [{ name: "zterm.who", effect: "read", reach: "anyone" }] }, needs: { tools: [] } },
    `export default { async start(ctx) { ctx.tool("zterm.who", { effect: "read", input: { type: "object", properties: {} }, run: async (i, meta) => ({ terminal: meta.terminal || null }) }); return {}; } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const withIt = await d.registry.call("zterm.who", {}, "cli", { terminal: { key: "pts/0#9@1", tty: "pts/0" } });
  assert.deepEqual(withIt.data, { terminal: { key: "pts/0#9@1", tty: "pts/0" } });
  assert.deepEqual((await d.registry.call("zterm.who", {}, "cli", {})).data, { terminal: null });
});
