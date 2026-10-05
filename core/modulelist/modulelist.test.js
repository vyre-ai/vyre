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
  const ctx = { tool: (n, d) => tools.set(n, d), modulesListReset: reset, kernel: { chain: async m => ({ hops: [m.who] }), proofFrom: m => (m.proof ? { presence: m.proof } : {}) } };
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
  for (const caller of ["mcp", "mcp:agent:kit", "anonymous", "guest:x"]) {
    const r = await d.registry.call("modules.list.reset", {}, caller, {});
    assert.ok(r.error && ["denied", "no_such_tool", "held_unavailable", "not_declared"].includes(r.error.code), `${caller}: ${JSON.stringify(r)}`);
  }
  assert.equal(d.kernel.log.read({ type: "kernel.modules-list-reset" }).length, 0, "nothing was reset");
});

/** The module with a fake kernel and a clock, all five tools. */
async function whole({ reset, payload }) {
  const tools = new Map();
  const clock = { t: 1_000_000 };
  const ctx = { tool: (n, d) => tools.set(n, d), now: () => clock.t, modulesListReset: reset, modulesListResetPayload: payload, kernel: { chain: async m => ({ hops: [m.who] }), proofFrom: m => (m.proof ? { presence: m.proof } : {}) } };
  await mod.start(ctx);
  return { t: tools, clock, run: (n, i, m = {}) => tools.get(n).run(i, m) };
}
const P = { op: "grant.modules_list_reset", space: "spc_x", fields: { counter: 7 }, payload_hash: "h7" };

test("rollback approval route: the box asks, the phone sees the card and signs, one answer resets, and every other path changes nothing", async () => {
  const resets = [];
  const w = await whole({ reset: async (chain, proof) => { resets.push(proof); return proof ? { ok: true } : { ok: false, why: "needs_presence" }; }, payload: ask => ({ ...P, fields: { ...P.fields, ask } }) });
  for (const n of ["modules.list.reset.ask", "modules.list.reset.status"]) assert.deepEqual(w.t.get(n).callers, ["cli", "local"], `${n}: the box's own surfaces only`);
  for (const n of ["modules.list.reset.ask", "modules.list.reset.pending", "modules.list.reset.answer", "modules.list.reset.status"]) assert.equal(w.t.get(n).callers.includes("mcp"), false, `${n}: never a model`);
  assert.deepEqual(await w.run("modules.list.reset.pending", {}), { none: true });
  const { id } = await w.run("modules.list.reset.ask", {});
  assert.deepEqual(await w.run("modules.list.reset.ask", {}).then(r => r.id), id, "one ask at a time");
  const card = await w.run("modules.list.reset.pending", {});
  assert.equal(card.id, id); assert.equal(card.payload_hash, "h7"); assert.deepEqual(card.fields, { counter: 7, ask: id }); assert.equal(card.op, "grant.modules_list_reset");
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "waiting" });
  // wrong id, and a no: nothing is reset
  await assert.rejects(() => w.run("modules.list.reset.answer", { id: "rr_other", approve: true }, { who: "owner", proof: { n: 1 } }), { code: "not_found" });
  // no proof on a yes: refused, still waiting, nothing reset
  await assert.rejects(() => w.run("modules.list.reset.answer", { id, approve: true }, { who: "owner" }), { code: "needs_presence" });
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "waiting" });
  assert.deepEqual(resets, [null]);
  // approved with a proof: one reset, then no ask is open
  assert.deepEqual(await w.run("modules.list.reset.answer", { id, approve: true }, { who: "owner", proof: { n: 2 } }), { answered: "approved" });
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "approved" });
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "none" }, "read once, then cleared");
  assert.deepEqual(await w.run("modules.list.reset.pending", {}), { none: true });
  await assert.rejects(() => w.run("modules.list.reset.ask", {}), { code: "rate_limited" }, "a new ask within 10 minutes is refused");
  await assert.rejects(() => w.run("modules.list.reset.answer", { id, approve: true }, { who: "owner", proof: { n: 3 } }), { code: "not_found" });
  assert.equal(resets.length, 2);
});

test("rollback approval route: a no, a timeout and a changed list each change nothing", async () => {
  let hash = "h7"; let resets = 0;
  const w = await whole({ reset: async () => { resets++; return { ok: true }; }, payload: ask => ({ ...P, fields: { ...P.fields, ask }, payload_hash: hash }) });
  let { id } = await w.run("modules.list.reset.ask", {});
  const ignored = await w.run("modules.list.reset.answer", { id, approve: false }, { who: "someone-with-a-label" });
  assert.equal(ignored.answered, "ignored", "a no from a label with no person session cancels nothing");
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "waiting" });
  assert.deepEqual(await w.run("modules.list.reset.answer", { id, approve: false }, { who: "owner", person: "per_alex" }), { answered: "refused" });
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "refused" });
  w.clock.t += 10 * 60_000 + 1;
  ({ id } = await w.run("modules.list.reset.ask", {}));
  w.clock.t += 5 * 60_000 + 1;
  assert.deepEqual(await w.run("modules.list.reset.pending", {}), { none: true }, "timed out");
  assert.deepEqual(await w.run("modules.list.reset.status", { id }), { state: "none" });
  await assert.rejects(() => w.run("modules.list.reset.answer", { id, approve: true }, { who: "owner", proof: { n: 1 } }), { code: "not_found" });
  w.clock.t += 10 * 60_000 + 1;
  ({ id } = await w.run("modules.list.reset.ask", {}));
  hash = "h8";
  await assert.rejects(() => w.run("modules.list.reset.answer", { id, approve: true }, { who: "owner", proof: { n: 1 } }), { code: "stale" });
  assert.equal(resets, 0, "nothing was reset");
  const none = await whole({ reset: async () => ({ ok: true }), payload: () => null });
  await assert.rejects(() => none.run("modules.list.reset.ask", {}), { code: "unavailable" });
});
