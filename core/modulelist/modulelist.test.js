import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import mod from "./index.js";

/** The module with a fake kernel: records what it was handed. */
async function loaded(reset) {
  const tools = new Map();
  const ctx = { tool: (n, d) => tools.set(n, d), modulesListReset: reset, kernel: { chain: async m => ({ hops: [m.who] }), proofFrom: m => m.proof } };
  await mod.start(ctx);
  return tools.get("modules.list.reset");
}

test("modules.list.reset hands the owner's chain and the proof to the kernel's reset; a refusal exits as an error, with no event of its own", async () => {
  const seen = [];
  const tool = await loaded(async (chain, proof) => { seen.push([chain, proof]); return proof ? { ok: true } : { ok: false, why: "needs_presence" }; });
  assert.deepEqual(tool.callers.includes("mcp"), false, "never a model, a guest or anonymous");
  assert.deepEqual(await tool.run({}, { who: "owner", proof: { n: 1 } }), { reset: true });
  await assert.rejects(() => tool.run({}, { who: "owner" }), { code: "needs_presence" });
  const other = await loaded(async () => ({ ok: false, why: "owner_only" }));
  await assert.rejects(() => other.run({}, { who: "viewer", proof: { n: 2 } }), { code: "denied" });
  const none = await loaded(undefined);
  await assert.rejects(() => none.run({}, { who: "owner" }), { code: "unavailable" });
});

test("on a real daemon: only the owner's own surfaces reach it, with no proof it is refused (exit non-zero), a model and a guest cannot call it", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const noProof = await call("modules.list.reset", {}, { root, caller: "cli" });
  assert.ok(noProof.error && noProof.error.code !== "no_such_tool", `the tool exists and refuses: ${JSON.stringify(noProof)}`);
  assert.equal(noProof.error.code, "unavailable", "a dev build has no signed list to reset, and says so");
  for (const caller of ["mcp", "mcp:agent:kit", "anonymous", "tailnet-guest:x"]) {
    const r = await d.registry.call("modules.list.reset", {}, caller, {});
    assert.ok(r.error && ["denied", "no_such_tool", "held_unavailable", "not_declared"].includes(r.error.code), `${caller}: ${JSON.stringify(r)}`);
  }
  assert.equal(d.kernel.log.read({ type: "kernel.modules-list-reset" }).length, 0, "nothing was reset");
});
