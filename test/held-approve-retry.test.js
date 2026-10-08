// @ts-check
// A held outward call that the person approves on the phone is redeemed for the asker that held it. Before 0.2.13 the card the registry held named no asking device,
// so the asker's retry was refused as a wrong request and nothing that waited for a yes could go out.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import mod from "../core/approvals/index.js";
import { yes, configureYes } from "../lib/one-yes.js";
import { holdFields } from "../core/modules/index.js";

const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));

test("a card held for the registry, approved with a real yes, is redeemed for its asker once, and for no other call or asker", async t => {
  t.after(() => configureYes({ verify: null }));
  configureYes({ softwareOk: () => true, verify: async ({ op, fields, proof }) => (proof && proof.ok === true && proof.for === canon({ op, fields: canon(fields) }) ? null : "bad_signature") });
  /** @type {Map<string, any>} */ const tools = new Map();
  await mod.start(/** @type {any} */ ({ tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), now: () => Date.now(), modules: { isOutward: (/** @type {string} */ n) => n === "mail.send" }, kernel: { proofFrom: (/** @type {any} */ m) => (m.proof ? { presence: m.proof } : undefined) } }));
  const asker = "mcp:agent:kit";
  const fields = holdFields({ to: "Northwind", subject: "Invoice 1042 is overdue" });
  const held = await tools.get("approvals.hold").run({ tool: "mail.send", fields, from: asker }, { caller: "module:registry" });
  const card = (await tools.get("approvals.pending").run({}, { caller: "cli" })).approvals.find((/** @type {any} */ c) => c.id === held.id);
  const proof = { ok: true, payload_hash: card.payload_hash, for: canon({ op: card.request.op, fields: canon(card.request.fields) }) };
  assert.equal((await tools.get("approvals.answer").run({ id: held.id, approve: true }, { caller: "device:phone", proof })).answered, "approved");
  assert.equal((await yes("outward", { op: "mail.send", fields: holdFields({ to: "Eastgate", subject: "x" }), device: asker }, { card: held.id })).ok, false, "not another call");
  assert.equal((await yes("outward", { op: "mail.send", fields, device: "mcp:agent:other" }, { card: held.id })).ok, false, "not another asker");
  assert.equal((await yes("outward", { op: "mail.send", fields, device: asker }, { card: held.id })).ok, true, "the asker's retry is redeemed");
  assert.equal((await yes("outward", { op: "mail.send", fields, device: asker }, { card: held.id })).ok, false, "once");
});
