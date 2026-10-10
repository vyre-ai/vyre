// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("spaces.records.status answers ready for a store with nothing to wait for, and is the person's own read", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const r = await d.registry.call("spaces.records.status", {}, "cli", { token: (await d.kernel.surfaces.open(chain, {})).token });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.ok(r.data.spaces.length >= 1 && r.data.spaces.every((/** @type {any} */ s) => s.ready === true), JSON.stringify(r.data));
  assert.ok((await d.registry.call("spaces.records.status", {}, "mcp", {})).error, "a model has no chain to read it under");
});
