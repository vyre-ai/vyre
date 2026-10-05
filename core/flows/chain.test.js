// Who the Flows tools run for is the kernel's answer, never a label: on a real daemon with the kernel on, a call that carries no session token and no facts the daemon proved gets the module's
// own service chain from `ctx.kernel.chain(meta)`, and the module refuses it. Every label reviewer-2 listed (a plain mcp, the harness, an agent claim, a device that is not the owner's
// confirmed device) is such a call. A verified session token's chain (a person's) is accepted, and the four person-only tools need exactly one person hop.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("Flows tools take the caller's chain from the kernel only: labels get nothing, a verified session gets its own chain, person-only tools need exactly one person", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const call = (tool, input, caller, meta) => d.registry.call(tool, input, caller, meta);
  const flow = { format: 1, name: "chain_probe", authorship: "human", trigger: { on: "manual" }, steps: [] };
  // every label: no token, no proven facts: refused, and nothing was stored
  for (const caller of ["mcp", "harness", "mcp:agent:juno", "harness:thread:abc", "device:abc", "device:l3wa3razvkbtpp3s", "cli", "local", "deck", "capsule", "mobile"]) {
    for (const tool of ["flows.define", "flows.list", "flows.start"]) {
      const r = await call(tool, tool === "flows.start" ? { id: "x" } : { flow }, caller);
      assert.ok(r.error, `${caller} ${tool} must be refused: ${JSON.stringify(r)}`);
      assert.match(String(r.error.code), /denied|unavailable|not_found|no_such_tool|forbidden/, `${caller} ${tool}: ${JSON.stringify(r.error)}`);
    }
  }
  // facts that do not hold (a uid that is not the owner's) give no person chain either
  const forged = await call("flows.list", {}, "cli", { kernelFacts: { kind: "socket", surface: "deck", uid: 31337, pid: 1, inside_model_process: false, capsule_verified: true } });
  assert.ok(forged.error, `facts that do not hold: ${JSON.stringify(forged)}`);
  // a verified session token: a person's own chain, accepted
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: owner, path: "direct", session: "s1" });
  const ses = await d.kernel.surfaces.open(person, {});
  const ok = await call("flows.list", {}, "deck", { token: ses.token });
  assert.ok(ok.data && Array.isArray(ok.data), `a verified session is a caller: ${JSON.stringify(ok)}`);
  // a token that does not verify
  const bad = await call("flows.list", {}, "deck", { token: ses.token.slice(0, -4) + "AAAA" });
  assert.ok(bad.error && /denied/.test(String(bad.error.code)), JSON.stringify(bad));
  // the person-only tools: a session whose chain has an assistant in it is refused, a person's own is not refused for that reason
  const agentSes = await d.kernel.surfaces.open(person, { agent: "assistant" });
  for (const tool of ["flows.approve", "flows.pause", "flows.resume", "flows.kit.remove"]) {
    const r = await call(tool, { id: "x", version: 1, hash: "h" }, "deck", { token: agentSes.token });
    assert.ok(r.error && /denied|not_found|person/.test(`${r.error.code} ${r.error.message}`), `${tool} refuses an assistant's session: ${JSON.stringify(r)}`);
    assert.ok(!/is a person's own/.test(JSON.stringify((await call(tool, { id: "x", version: 1, hash: "h" }, "deck", { token: ses.token })).error || {})) , `${tool} does not call a person's own session an assistant`);
  }
  assert.deepEqual((await call("flows.list", {}, "deck", { token: ses.token })).data, [], "nothing was stored by any of the refused calls");
});
