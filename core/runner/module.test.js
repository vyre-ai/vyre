// @ts-check
// The runner module in a real vyred: manifest, tools, the not-connected answer, and place/start through seam ports.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { seams } from "./index.js";
import { fakeSpace } from "./testing/fake-space.js";

async function boot(t, ports) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", modules: { disable: ["agents", "computers"] } }));
  if (ports) seams.set(root, { ports });
  t.after(() => seams.delete(root));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const mod = d.registry.modules.get("runner");
  assert.equal(mod?.state, "running", `runner did not start: ${mod?.error}`);
  return { d, call: (tool, input = {}) => d.registry.call(tool, input, "cli") };
}

test("runner module: loads with its tools and says plainly that it is not connected yet", async t => {
  const s = await boot(t);
  const tools = s.d.registry.modules.get("runner").manifest.does.tools.map(x => x.name);
  assert.deepEqual(tools.sort(), ["runner.lock", "runner.move", "runner.place", "runner.start", "runner.status", "runner.stop"]);
  const visible = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("runner."));
  assert.deepEqual(visible.sort(), ["runner.lock", "runner.move", "runner.place", "runner.status"], "start and stop are for other modules only; revoke is no tool at all");
  const st = await s.call("runner.status");
  assert.equal(st.data.ready, false);
  assert.match(st.data.why, /not connected|installed|blocks|missing/);
  const r = await s.call("runner.place", { space: "harlow" });
  assert.match(JSON.stringify(r), /not connected/);
  assert.ok(!r.data, "no answer is invented");
});

test("runner module: place answers from the grants and the server's room", async t => {
  const sp = fakeSpace();
  const s = await boot(t, { device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: false, memberAccepts: true }), server: () => ({ available: true, hasRoom: true }) });
  const r = await s.call("runner.place", { space: "harlow" });
  assert.equal(r.data.where, "server");
  assert.match(r.data.reason, /has not allowed members/);
});
