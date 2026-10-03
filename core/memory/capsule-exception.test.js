// The Capsule exception in core/memory/kernel-gate.js is temporary: platform has not yet wired the Capsule's code-signature check into the daemon's proven facts, so a Capsule
// call reaches a module with no kernel chain. THIS TEST FAILS the day it does: then CAPSULE_EXCEPTION is no longer needed and must be deleted from the gate (and its line from
// CUTOVER.md). It runs a real daemon with the kernel on, like test/threadsock.test.js; run it on a test box, never on a person's Mac.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { CAPSULE_EXCEPTION } from "./kernel-gate.js";

test("a Capsule call still carries no person chain in a module, so the named exception is still needed", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const fp = path.join(root, "modules");
  fs.mkdirSync(fp, { recursive: true });
  writeModule(fp, "zz-who", { does: { tools: [{ name: "zz-who.me", reach: "anyone" }] }, needs: { kernel: { actions: [] } } }, `
    export default { async start(ctx) { ctx.tool("zz-who.me", { run: async (i, meta) => {
      const c = await ctx.kernel.chain(meta);
      return { hops: c.hops.map(h => [h.actor.kind, h.actor.id, h.via && h.via.surface || null]) };
    } }); return {}; } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [fp] });
  t.after(() => d.stop());
  const r = /** @type {any} */ (await call("zz-who.me", {}, { root, caller: CAPSULE_EXCEPTION }));
  const hops = r.data ? r.data.hops : [];
  assert.ok(hops.length > 0 && hops.every((/** @type {any} */ h) => h[0] === "service"),
    `A Capsule call now carries a person chain (${JSON.stringify(r)}): delete CAPSULE_EXCEPTION from core/memory/kernel-gate.js, this test, and its line in team/0.3/CUTOVER.md.`);
});
