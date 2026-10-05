// @ts-check
// Spending limits and standing permissions (the Deck's settings-spend and settings-permissions, ported) over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const SPEND = { day: "2026-10-05", all: { spent: 4.5, cap: 20, capped: false }, providers: [{ provider: "claude", spent: 4.25, cap: 5, capped: true, estimated: true }, { provider: "codex", spent: 0.25, cap: null }, { nope: 1 }] };
const SAID = { intents: [
  { id: "i1", kind: "send", channel: "slack", to: ["#ops"], standing: true, agents: ["juno"], at: 1_000_000, used: 2_000_000 },
  { id: "i2", kind: "pay", to: ["acme"], standing: true, limits: { max_amount: 50, currency: "usd" }, at: 1 },
  { id: "i3", kind: "post", to: ["blog"], standing: false, when: "Friday", at: 0 },
  { id: "i4", kind: "send", to: ["x"], standing: true, revoked: 9 },
] };

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (o[tool]) return o[tool];
    return { data: tool === "spend.summary" ? SPEND : tool === "gate.said.list" ? SAID : {} };
  };
  return { call, seen };
}

test("spend: all providers first, a cap of zero or none is no cap, the words say paused", { skip: !strip }, async () => {
  const m = await import("./limits-model.ts");
  const { limitsSource } = await import("./limits-source.ts");
  const s = await limitsSource(box().call).spend();
  assert.equal(s.day, "2026-10-05");
  assert.deepEqual(s.rows.map((r) => r.provider), ["all", "claude", "codex"]);
  assert.deepEqual(s.rows.map(m.spendWords), ["$4.50 of $20.00 today", "$4.25 of $5.00 today, paused", "$0.25 today, no cap"]);
  assert.equal(m.spendName("all"), "All providers together");
  assert.equal(m.spendName("codex"), "Codex");
});

test("spend: a typed cap is dollars above zero to the cent; anything else says so and sends nothing", { skip: !strip }, async () => {
  const { limitsSource } = await import("./limits-source.ts");
  const b = box();
  const s = limitsSource(b.call);
  await s.setCap("claude", " $12.345 ");
  await s.noCap("codex");
  for (const bad of ["", "0", "-3", "abc"]) await assert.rejects(s.setCap("claude", bad), /more than zero/);
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["spend.raise", { provider: "claude", to: 12.35 }], ["spend.raise", { provider: "codex", off: true }]]);
});

test("permissions: revoked ones are dropped, each reads as one sentence with its limit", { skip: !strip }, async () => {
  const m = await import("./limits-model.ts");
  const { limitsSource } = await import("./limits-source.ts");
  const items = await limitsSource(box().call).permissions();
  assert.deepEqual(items.map((i) => i.id), ["i1", "i2", "i3"]);
  assert.deepEqual(items.map(m.sentence), ["juno may send to #ops on slack", "Any of your agents may pay acme, up to 50 USD", "Any of your agents may post to blog"]);
  assert.match(m.permissionMeta(items[0], 1_000_000 + 3 * 60_000), /^Standing permission · added 3 min ago · used /);
  assert.match(m.permissionMeta(items[2]), /^Asked for Friday/);
});

test("permissions: the form needs a recipient, a payment needs an amount, and a payment or a blanket allow asks for proof", { skip: !strip }, async () => {
  const m = await import("./limits-model.ts");
  const { limitsSource } = await import("./limits-source.ts");
  assert.match(/** @type {any} */ (m.addInput(m.EMPTY_FORM)).problem, /at least one exact address/);
  assert.match(/** @type {any} */ (m.addInput({ ...m.EMPTY_FORM, kind: "pay", to: "acme" })).problem, /most-per-payment/);
  const narrow = /** @type {any} */ (m.addInput({ ...m.EMPTY_FORM, to: "a@x.example, b@x.example", agents: "juno", channel: " mail " }));
  assert.deepEqual(narrow, { input: { kind: "send", to: ["a@x.example", "b@x.example"], channel: "mail", agents: ["juno"] }, proof: false });
  const blanket = /** @type {any} */ (m.addInput({ ...m.EMPTY_FORM, to: "#ops" }));
  assert.equal(blanket.proof, true);
  const pay = /** @type {any} */ (m.addInput({ ...m.EMPTY_FORM, kind: "pay", to: "acme", amount: "50", currency: "usd", agents: "kit" }));
  assert.deepEqual([pay.input.limits, pay.proof], [{ max_amount: 50, currency: "USD" }, true]);
  const b = box();
  const s = limitsSource(b.call);
  await s.allow({ ...m.EMPTY_FORM, to: "#ops", agents: "juno" });
  await s.takeBack("i1");
  await assert.rejects(s.allow(m.EMPTY_FORM), /exact address/);
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [["gate.said.add", { kind: "send", to: ["#ops"], agents: ["juno"] }], ["gate.said.revoke", { id: "i1" }]]);
});
