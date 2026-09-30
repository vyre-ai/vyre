// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  dispatchEvent: () => true, queueMicrotask: () => {},
});
const calls = /** @type {any[]} */ ([]);
function vyred(answers = {}) {
  calls.length = 0;
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const a = tool in answers ? answers[tool] : {};
    return a && a.$error ? { status: 409, statusText: "", json: async () => ({ error: a.$error }) } : { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));
const { spendCapped } = await import("./spend-capped.js");
const EVENT = { provider: "claude", day: "2026-10-01", spent: 5.02, cap: 5, line: "Claude spend today reached $5.02 of the $5.00 daily cap, so this is paused. Raise it: vyre spend raise claude <dollars>", thread: "t1",
  action: { label: "Raise it", tool: "vault.reveal", input: { provider: "claude", to: 10 } } };

test("the box's line and a Raise it; the field opens with the suggested amount and nothing is sent yet", () => {
  vyred();
  const el = spendCapped(EVENT);
  assert.match(text($(el, ".cv-spend-line")), /Claude spend today reached \$5\.02 of the \$5\.00 daily cap/);
  assert.equal(text($(el, "[data-act=raise]")), "Raise it");
  click($(el, "[data-act=raise]"));
  assert.equal($(el, ".cv-spend-amount").value, "10");
  assert.equal(calls.length, 0);
});

test("Raise calls spend.raise with the provider and the typed amount, never the tool the event names", async () => {
  vyred({ "spend.raise": { provider: "claude", cap: 12.5, was: 5, spent: 5.02 } });
  let cap = "unset";
  const el = spendCapped(EVENT, { onRaised: c => { cap = String(c); } });
  click($(el, "[data-act=raise]"));
  $(el, ".cv-spend-amount").value = "$12.50";
  $(el, "form").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit"));
  await settle();
  assert.deepEqual(calls.map(c => c.tool), ["spend.raise"]);
  assert.deepEqual(calls[0].input, { provider: "claude", to: 12.5 });
  assert.match(text($(el, ".cv-spend-line")), /daily cap is \$12\.50/);
  assert.equal(cap, "12.5");
  assert.equal($(el, "[data-act=raise]"), null);
});

test("No cap sends off; a bad amount is refused in words before anything is sent; a refusal shows and keeps the field", async () => {
  vyred({ "spend.raise": { $error: { code: "denied", message: "not here" } } });
  const el = spendCapped(EVENT);
  click($(el, "[data-act=raise]"));
  $(el, ".cv-spend-amount").value = "abc";
  $(el, "form").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit"));
  await settle();
  assert.equal(calls.length, 0);
  assert.match(text($(el, ".cv-spend-problem")), /more than zero/);
  click($(el, "[data-act=off]")); await settle();
  assert.deepEqual(calls[0].input, { provider: "claude", off: true });
  assert.match(text($(el, ".cv-spend-problem")), /did not go through/);
  assert.ok($(el, ".cv-spend-amount"));
});

test("a provider that is not a plain name gets the line and no Raise it; the amount must be a finite number above zero", () => {
  vyred();
  const el = spendCapped({ ...EVENT, provider: "claude; drop" });
  assert.ok($(el, ".cv-spend-line"));
  assert.equal($(el, "[data-act=raise]"), null);
  for (const bad of ["Infinity", "-3", "0", "1e999"]) {
    const e2 = spendCapped(EVENT);
    click($(e2, "[data-act=raise]"));
    $(e2, ".cv-spend-amount").value = bad;
    $(e2, "form").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit"));
    assert.equal(calls.length, 0, bad);
  }
});

test("the cap over every provider: provider all raises with provider all", async () => {
  vyred({ "spend.raise": { provider: "all", cap: 40 } });
  const el = spendCapped({ ...EVENT, provider: "all", thread: undefined });
  click($(el, "[data-act=raise]"));
  $(el, ".cv-spend-amount").value = "40";
  $(el, "form").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit"));
  await settle();
  assert.deepEqual(calls[0].input, { provider: "all", to: 40 });
  assert.match(text($(el, ".cv-spend-line")), /The daily cap over every provider is \$40\.00/);
});
