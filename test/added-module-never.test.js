// @ts-check
// A module someone adds can never name a tool that pairs, admits or drops a device or sets the server up (those change who can reach the server), whatever its manifest says.
// A real daemon with the real presence check and real added modules in the home's modules folder.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, writeModule } from "./helpers.js";

const NEVER = ["relay.pair.start", "relay.devices.drop", "relay.devices.admit-server", "relay.devices.drop-server", "relay.setup.begin"];
const TRY = `export default { async start(ctx) {
  ctx.tool("polite.go", { effect: "read", input: { type: "object", properties: { tool: { type: "string" } } },
    run: async ({ tool }) => { try { const r = await ctx.call(tool, {}); return { ok: true, error: r && r.error ? r.error.code : null }; } catch (e) { return { ok: false, code: e.code }; } } });
  return { async stop() {} };
} };`;

test("a real daemon refuses an added module that lists a pairing, device or setup tool, and denies a call it was never allowed to make", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [] }));
  const mods = path.join(root, "modules");
  writeModule(mods, "sneaky", { description: "x", does: { tools: [{ name: "sneaky.go", reach: "asked" }] }, needs: { tools: [...NEVER, "spaces.brief"] } }, TRY.replaceAll("polite.", "sneaky."));
  writeModule(mods, "polite", { description: "x", does: { tools: [{ name: "polite.go", reach: "asked" }] }, needs: { tools: ["spaces.brief", "link.status", "relay.setup.status"] } }, TRY);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const sneaky = d.registry.modules.get("sneaky");
  assert.ok(sneaky && sneaky.state !== "running", `sneaky must not run: ${sneaky && sneaky.state}`);
  for (const tool of NEVER) assert.match(String(sneaky.error), new RegExp(tool.replaceAll(".", "\\.")), tool);
  const polite = d.registry.modules.get("polite");
  assert.equal(polite.state, "running", String(polite.error));
  for (const tool of [...NEVER, "link.pair", "wink.approve", "presence.enroll"]) {
    const r = await d.registry.call("polite.go", { tool }, "cli");
    assert.deepEqual(r.data, { ok: false, code: "denied" }, tool);
  }
  // the reads it listed still work for it
  for (const tool of ["spaces.brief", "link.status", "relay.setup.status"]) {
    const r = await d.registry.call("polite.go", { tool }, "cli");
    assert.ok(r.data && r.data.ok !== false || (r.data && r.data.code !== "denied" && r.data.code !== "undeclared"), `${tool}: ${JSON.stringify(r)}`);
  }
});
