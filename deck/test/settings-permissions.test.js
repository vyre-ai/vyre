// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { dispatchEvent: () => true });
const { drawPermissions, intentsOf, sentence } = await import("../views/settings-permissions.js");

const LIST = { intents: [
  { id: "s1", kind: "send", channel: "email", to: ["lee@firm.com"], standing: true, agents: ["kit"], at: 1, revoked: null },
  { id: "p1", kind: "pay", to: ["acme"], standing: true, agents: [], limits: { max_amount: 50, currency: "usd" }, at: 1 },
  { id: "o1", kind: "post", channel: "slack", to: ["#ops"], standing: false, when: "tonight", at: 1 },
  { id: "gone", kind: "send", to: ["x@y.z"], standing: true, revoked: 5 }] };
function mount(answers) {
  const calls = [];
  const attempt = async (tool, input = {}, opts) => { calls.push({ tool, input, opts }); const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.$error ? { error: a.$error } : { data: a ?? {} }; };
  const el = doc.createElement("div");
  return { el, calls, run: () => drawPermissions(el, { alive: () => true, on: () => {} }, { attempt }) };
}
const ev = n => new /** @type {any} */ (globalThis).Event(n);
const settle = () => new Promise(r => setTimeout(r, 10));

test("revoked intents are dropped and each one reads as a sentence", () => {
  const items = intentsOf(LIST);
  assert.deepEqual(items.map(i => i.id), ["s1", "p1", "o1"]);
  assert.equal(sentence(items[0]), "kit may send to lee@firm.com on email");
  assert.match(sentence(items[1]), /Any of your agents may pay acme, up to 50 USD/);
});

test("standing and once-only lists are split; Take back sends gate.said.revoke with that id and reloads", async () => {
  const m = mount({ "gate.said.list": LIST, "gate.said.revoke": {} });
  await m.run();
  assert.equal($$(m.el, "[data-intent]").length, 3);
  $(m.el, "[data-intent=s1] [data-act=revoke]").dispatchEvent(ev("click")); await settle();
  assert.deepEqual(m.calls.filter(c => c.tool === "gate.said.revoke").map(c => c.input), [{ id: "s1" }]);
  assert.equal(m.calls.filter(c => c.tool === "gate.said.list").length, 2);
});

test("Add: a permission with no recipient sends nothing; a pay one needs an amount; a good one sends gate.said.add", async () => {
  const m = mount({ "gate.said.list": { intents: [] }, "agents.list": [], "gate.said.add": { id: "n1" } });
  await m.run();
  assert.match(text(m.el), /No standing permissions/);
  $(m.el, "[data-act=add]").dispatchEvent(ev("click")); await settle();
  const form = () => $(m.el, "[data-form=permission]");
  form().dispatchEvent(ev("submit")); await settle();
  assert.equal(m.calls.filter(c => c.tool === "gate.said.add").length, 0);
  assert.match(text(m.el), /at least one exact address/);
  $(m.el, "[data-f=to]").value = "a@b.co, c@d.co";
  $(m.el, "[data-f=kind]").value = "pay";
  form().dispatchEvent(ev("submit")); await settle();
  assert.equal(m.calls.filter(c => c.tool === "gate.said.add").length, 0);
  assert.match(text(m.el), /most-per-payment/);
  $(m.el, "[data-f=amount]").value = "25"; $(m.el, "[data-f=currency]").value = "usd";
  form().dispatchEvent(ev("submit")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "gate.said.add")?.input, { kind: "pay", to: ["a@b.co", "c@d.co"], limits: { max_amount: 25, currency: "USD" } });
  assert.deepEqual(m.calls.find(c => c.tool === "gate.said.add")?.opts, { presence: true }, "a pay permission asks for proof");
});

test("a failed read says so instead of showing an empty list", async () => {
  const m = mount({ "gate.said.list": { $error: { message: "no" } } });
  await m.run();
  assert.match(text(m.el), /could not be read/);
});
