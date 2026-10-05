import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { request } from "../core/daemon/client.js";

test("a Basic device boots clean with Flows off: every module runs, no Flow, Kit, role or view type is defined, no refusal anywhere", { timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
  const root = tempHome(t);
  const lines = [];
  const d = await start({ root, log: l => lines.push(String(l)), kernel: true, basic: true });
  t.after(() => d.stop());
  const h = (await request("GET", "/v1/health", undefined, { root })).data;
  assert.equal(h.modules.failed, 0, JSON.stringify(h.modules));
  assert.equal(h.records_store.store, "builtin", "the device's own store");
  assert.equal(h.records_store.reachable, true);
  assert.equal(h.records_store.note, undefined, "no Records refusal");
  const types = (await d.kernel.store.types()).map(x => x.name);
  for (const n of ["def-flow", "flow-run", "def-role", "def-view", "template", "contact"]) assert.ok(!types.includes(n), `${n} is not defined on a Basic device`);
  assert.ok(!lines.some(l => /could not define the Flow record types|cannot run the record store/.test(l)), lines.join("\n"));
});
