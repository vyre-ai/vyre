import test from "node:test";
import assert from "node:assert/strict";
import mod from "./index.js";
import { payloadHash } from "../../kernel/seal/wire.js";

const SPACE = "spc_aaaaaaaaaaaa";
async function world() {
  const tools = new Map(), clock = { t: 1_000_000 };
  await mod.start({ tool: (n, d) => tools.set(n, d), now: () => clock.t, kernel: { proofFrom: m => (m.proof ? { presence: m.proof } : undefined) } });
  return { tools, clock, run: (n, i, m = {}) => tools.get(n).run(i, m) };
}
const FIELDS = { resource: `vyre://${SPACE}/invite/new`, input_hash: "h1" };

test("approve on your phone: the web app asks, the phone lists it and signs, the web app reads the proof back once", async () => {
  const w = await world();
  for (const n of ["approvals.ask", "approvals.pending", "approvals.answer", "approvals.status"]) { assert.equal(w.tools.get(n).callers.includes("mcp"), false, `${n}: never a model`); assert.equal(w.tools.get(n).callers.includes("deck"), true); }
  const asked = await w.run("approvals.ask", { op: "grant.invite", space: SPACE, fields: FIELDS }, { caller: "device:web1" });
  assert.equal(asked.payload_hash, payloadHash("grant.invite", SPACE, FIELDS));
  const [card] = (await w.run("approvals.pending", {}, { caller: "device:phone" })).approvals;
  assert.equal(card.id, asked.id); assert.equal(card.title, "Invite someone to this space"); assert.equal(card.asked_from, "device:web1"); assert.equal(card.payload_hash, asked.payload_hash);
  // wrong payload and no proof change nothing
  await assert.rejects(() => w.run("approvals.answer", { id: asked.id, approve: true }, { caller: "device:phone", proof: { payload_hash: "other" } }), { code: "needs_presence" });
  await assert.rejects(() => w.run("approvals.answer", { id: asked.id, approve: true }, { caller: "device:phone" }), { code: "needs_presence" });
  assert.deepEqual(await w.run("approvals.status", { id: asked.id }, { caller: "device:web1" }), { state: "waiting" });
  // another session cannot read the asker's outcome
  const proof = { payload_hash: asked.payload_hash, signature: "sig", nonce: "n" };
  assert.deepEqual(await w.run("approvals.answer", { id: asked.id, approve: true }, { caller: "device:phone", proof }), { answered: "approved" });
  assert.deepEqual(await w.run("approvals.status", { id: asked.id }, { caller: "device:other" }), { state: "none" });
  assert.deepEqual(await w.run("approvals.status", { id: asked.id }, { caller: "device:web1" }), { state: "approved", proof });
  assert.deepEqual(await w.run("approvals.status", { id: asked.id }, { caller: "device:web1" }), { state: "none" }, "read once");
});

test("approve on your phone: a no needs the person's session, a timeout and bad asks change nothing, and the open list is capped", async () => {
  const w = await world();
  const ask = (f = FIELDS) => w.run("approvals.ask", { op: "grant.role", space: SPACE, fields: f }, { caller: "deck" });
  const a = await ask();
  assert.equal((await w.run("approvals.answer", { id: a.id, approve: false }, { caller: "device:p" })).answered, "ignored");
  assert.equal((await w.run("approvals.answer", { id: a.id, approve: false }, { caller: "device:p", person: "ps1" })).answered, "refused");
  assert.deepEqual(await w.run("approvals.status", { id: a.id }, { caller: "deck" }), { state: "refused" });
  const b = await ask({ ...FIELDS, input_hash: "h2" });
  w.clock.t += 5 * 60_000 + 1;
  assert.deepEqual((await w.run("approvals.pending", {})).approvals, [], "timed out");
  await assert.rejects(() => w.run("approvals.answer", { id: b.id, approve: true }, { proof: { payload_hash: b.payload_hash } }), { code: "not_found" });
  for (const bad of [{ op: "seal.reveal", space: SPACE, fields: FIELDS }, { op: "grant.role", space: "nope", fields: FIELDS }, { op: "grant.role", space: SPACE, fields: [] }]) await assert.rejects(() => w.run("approvals.ask", bad, { caller: "deck" }), { code: "bad_input" });
  for (let i = 0; i < 5; i++) await ask({ ...FIELDS, input_hash: `x${i}` });
  await assert.rejects(() => ask({ ...FIELDS, input_hash: "x9" }), { code: "rate_limited" });
});

import { proofRequest } from "../../kernel/remote/proof.js";
test("approvals.request returns exactly the kernel's proof request for an act, and refuses a name it does not know", async () => {
  const w = await world();
  const args = [{ person: "per_alexalexalexalexalexalex", role: "admin" }];
  const r = await w.run("approvals.request", { space: SPACE, call: "setRole", args }, { caller: "deck" });
  const want = proofRequest(SPACE, "setRole", ...args);
  assert.deepEqual(r, { op: want.op, space: want.space, fields: want.fields, payload_hash: want.payload_hash });
  // what the phone signs is what approvals.ask would hold for the same op and fields
  const asked = await w.run("approvals.ask", { op: r.op, space: r.space, fields: r.fields }, { caller: "device:web" });
  assert.equal(asked.payload_hash, r.payload_hash);
  await assert.rejects(() => w.run("approvals.request", { space: SPACE, call: "nope", args: [] }, { caller: "deck" }), { code: "bad_input" });
  await assert.rejects(() => w.run("approvals.request", { space: "x", call: "setRole", args }, { caller: "deck" }), { code: "bad_input" });
});
