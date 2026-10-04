// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
Object.assign(globalThis, { dispatchEvent: () => true });
const { drawSpend, providersOf } = await import("../views/settings-spend.js");

const SUMMARY = { day: "2026-10-01", providers: [
  { provider: "claude", spent: 5.02, cap: 5, left: 0, capped: true, calls: 12, estimated: false },
  { provider: "codex", spent: 0.4, cap: null, left: null, capped: false, calls: 3, estimated: true }] };
function mount(answers) {
  const calls = [], subs = [];
  const attempt = async (tool, input = {}) => { calls.push({ tool, input }); const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.$error ? { error: a.$error } : { data: a ?? {} }; };
  const el = doc.createElement("div");
  const ctx = { alive: () => true, on: (t, fn) => subs.push([t, fn]) };
  return { el, calls, subs, run: () => drawSpend(el, ctx, { attempt }) };
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));

test("providersOf keeps provider rows only and reads a missing cap as none", () => {
  assert.deepEqual(providersOf(SUMMARY).map(p => [p.provider, p.cap, p.capped]), [["claude", 5, true], ["codex", null, false]]);
  assert.deepEqual(providersOf(null), []);
});

test("each provider's spend against its cap, paused marked, estimated said", async () => {
  const m = mount({ "spend.summary": SUMMARY });
  await m.run();
  assert.match(text($(m.el, "[data-provider=claude]")), /\$5\.02 of \$5\.00 today, paused/);
  assert.match(text($(m.el, "[data-provider=codex]")), /\$0\.40 today, no cap.*estimated from tokens/);
  assert.deepEqual(m.calls.map(c => c.tool), ["spend.summary"]);
  assert.deepEqual(m.subs.map(s => s[0]).sort(), ["spend.capped", "spend.raised"]);
});

test("Change cap opens a field; Set cap sends spend.raise to that amount, No cap sends off, a bad amount sends nothing", async () => {
  const m = mount({ "spend.summary": SUMMARY, "spend.raise": { cap: 12 } });
  await m.run();
  click($(m.el, "[data-provider=claude] [data-act=edit]"));
  $(m.el, "[data-provider=claude] input").value = "x";
  $(m.el, "[data-provider=claude]").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit")); await settle();
  assert.equal(m.calls.filter(c => c.tool === "spend.raise").length, 0);
  assert.match(text($(m.el, "[data-provider=claude]")), /more than zero/);
  $(m.el, "[data-provider=claude] input").value = "$12";
  $(m.el, "[data-provider=claude]").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "spend.raise")?.input, { provider: "claude", to: 12 });
  assert.equal(m.calls.filter(c => c.tool === "spend.summary").length, 2, "reloaded after the change");
  click($(m.el, "[data-provider=codex] [data-act=edit]"));
  click($(m.el, "[data-provider=codex] [data-act=off]")); await settle();
  assert.deepEqual(m.calls.filter(c => c.tool === "spend.raise").at(-1)?.input, { provider: "codex", off: true });
});

test("no spend module: one plain line", async () => {
  const m = mount({ "spend.summary": { $error: { code: "no_such_tool", message: "no such tool", missing: true, module: "spend" } } });
  await m.run();
  assert.match(text(m.el), /Spend is not tracked on your server yet/);
});

test("the cap over every provider is its own row, changed through spend.raise with provider all", async () => {
  const m = mount({ "spend.summary": { ...SUMMARY, all: { spent: 5.42, cap: 20, left: 14.58, capped: false } }, "spend.raise": { cap: 30 } });
  await m.run();
  assert.match(text($(m.el, "[data-provider=all]")), /All providers together.*\$5\.42 of \$20\.00 today/);
  click($(m.el, "[data-provider=all] [data-act=edit]"));
  $(m.el, "[data-provider=all] input").value = "30";
  $(m.el, "[data-provider=all]").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit")); await settle();
  assert.deepEqual(m.calls.find(c => c.tool === "spend.raise")?.input, { provider: "all", to: 30 });
});
