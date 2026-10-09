// @ts-check
// `flows.kit.credentials` in a real vyred: only the vault may ask, and a task no approved Kit version names credentials for is refused (the vault then lends nothing).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("flows.kit.credentials: refused to every caller but the vault; for the vault, a task with no Kit is not_found", { timeout: 120_000 }, async (t) => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ask = (/** @type {string} */ caller) => d.registry.call("flows.kit.credentials", { task: "no-such-task" }, caller);
  for (const caller of ["cli", "module:approvals", "module:flows", "mcp:agent:kit"]) assert.ok((await ask(caller)).error, `${caller} must be refused`);
  const r = await ask("module:vault");
  assert.equal(r.error?.code, "not_found", JSON.stringify(r));
  assert.match(String(r.error?.message), /no approved Kit version/);
});
