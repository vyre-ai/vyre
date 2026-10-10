// @ts-check
// The runner module in a real vyred: manifest, tools, the not-connected answer, and place/start through seam ports.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
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
  assert.deepEqual(tools.sort(), ["runner.folders", "runner.folders.allow", "runner.folders.available", "runner.folders.remove", "runner.here", "runner.lock", "runner.move", "runner.pause-all", "runner.place", "runner.placement", "runner.places", "runner.preview", "runner.recover", "runner.resume-all", "runner.resume-lent", "runner.revoke", "runner.settings", "runner.settings.set", "runner.start", "runner.status", "runner.stop", "runner.why-not"]);
  const visible = s.d.registry.listTools().map(x => x.name).filter(n => n.startsWith("runner."));
  assert.deepEqual(visible.sort(), ["runner.folders", "runner.folders.allow", "runner.folders.available", "runner.folders.remove", "runner.here", "runner.lock", "runner.move", "runner.pause-all", "runner.place", "runner.placement", "runner.places", "runner.preview", "runner.resume-all", "runner.settings", "runner.settings.set", "runner.start", "runner.status", "runner.stop", "runner.why-not"], "start and stop are the person's; revoke is no tool at all");
  const st = await s.call("runner.status");
  assert.equal(st.data.ready, false);
  assert.match(st.data.why, /not connected|installed|blocks|missing|no device identity/);
  const r = await s.call("runner.place", { space: "harlow" });
  assert.match(JSON.stringify(r), /not connected|device identity|no such Space/);
  assert.ok(!r.data, "no answer is invented");
});

test("runner module: place answers from the grants and the server's room", async t => {
  const sp = fakeSpace();
  const s = await boot(t, { device: "kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: false, memberAccepts: true }), server: () => ({ available: true, hasRoom: true }) });
  const r = await s.call("runner.place", { space: "harlow" });
  assert.equal(r.data.where, "server");
  assert.match(r.data.reason, /has not allowed members/);
});

test("runner module: a module cannot start or stop a session, and status shows no host path", async t => {
  const sp = fakeSpace();
  const s = await boot(t, { device: "dev_kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), spec: async () => ({}) });
  for (const tool of ["runner.start", "runner.stop"]) {
    const r = await s.d.registry.call(tool, { space: "harlow", session: "s1" }, "module:rogue");
    assert.ok(!r.data, `${tool} refused for a module caller`);
  }
  const st = await s.call("runner.status");
  assert.ok(!JSON.stringify(st).includes("spaces/"), "no host path in status");
});

test("runner module: ports without a device key are refused", async t => {
  const sp = fakeSpace();
  const s = await boot(t, { vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }) });
  const r = await s.call("runner.place", { space: "harlow" });
  assert.match(JSON.stringify(r), /device key/);
});

test("runner module: an assistant's claim on the CLI is refused for start, stop, lock and move, and the person's own CLI is not", async t => {
  const sp = fakeSpace();
  const s = await boot(t, { device: "dev_kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), spec: async () => ({}) });
  for (const [tool, input] of [["runner.start", { space: "harlow", session: "s1" }], ["runner.stop", { space: "harlow", session: "s1" }], ["runner.lock", { space: "harlow" }], ["runner.move", { space: "harlow", session: "s1" }]]) {
    const agent = await s.d.registry.call(tool, input, "cli:agent:kit");
    assert.match(JSON.stringify(agent), /not the person|denied/, `${tool} refused for an assistant's CLI claim`);
    const own = await call(tool, input, { root: s.d.paths.root, caller: "cli" });
    assert.ok(!/not the person/.test(JSON.stringify(own)), `${tool} is not refused for the person's own CLI`);
  }
});
