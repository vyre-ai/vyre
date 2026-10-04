// @ts-check
// The charter-changed notice: who, the diff on request, a one-tap Revert. Sample world only.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  dispatchEvent: () => true, CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } } });
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body) });
    const a = tool in answers ? answers[tool] : {};
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 10));
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const { charterChanged, agentMade } = await import("./charter-changed.js");
const change = (o = {}) => ({ agent: "reviewer-harlow-legal", project: "harlow-legal", version: 3, previous: 2, by: "kit", note: "tightened the review checklist", at: Date.now(), ...o });

test("agentMade: an agent's name is news, the person's own surfaces are not", () => {
  assert.equal(agentMade("kit"), true);
  for (const b of ["deck", "cli", "local", "capsule", "", null]) assert.equal(agentMade(b), false, String(b));
});

test("a quiet row: who changed it, the note, Revert and Show changes; nothing here approves or blocks", () => {
  vyred();
  const c = charterChanged(change());
  assert.match(text($(c, ".cv-charter-line")), /Charter changed by kit · tightened the review checklist/);
  assert.ok($(c, "[data-act=revert]") && $(c, "[data-act=show]"));
  assert.equal($$(c, ".btn-primary").length, 0);
  assert.equal(c.getAttribute("aria-live"), "polite");
});

test("Show changes reads team.charter.diff for that version and draws the lines; Hide closes it", async () => {
  const v = vyred({ "team.charter.diff": { agent: "reviewer-harlow-legal", version: 3, text: "Review every PR.\nAsk before merging.", before: { version: 2, text: "Review every PR." } } });
  const c = charterChanged(change());
  click($(c, "[data-act=show]")); await settle();
  assert.deepEqual(v.of("team.charter.diff")[0].input, { teammate: "reviewer-harlow-legal", version: 3 });
  assert.ok($(c, ".cv-charter-diff"));
  assert.match(text($(c, ".cv-charter-diff")), /Ask before merging/);
  click($(c, "[data-act=show]")); await settle();
  assert.equal($(c, ".cv-charter-diff"), null);
});

test("Revert calls team.charter.revert with the version before, then says so in place", async () => {
  const v = vyred({ "team.charter.revert": { version: 4 } });
  const c = charterChanged(change());
  click($(c, "[data-act=revert]")); await settle();
  assert.deepEqual(v.of("team.charter.revert")[0].input, { teammate: "reviewer-harlow-legal", version: 2 });
  assert.match(text($(c, ".cv-charter-line")), /Charter back to version 2 · was changed by kit/);
  assert.equal($(c, "[data-act=revert]"), null);
});

test("a first version has nothing to revert to; a refused revert says so and keeps the button", async () => {
  vyred({ "team.charter.revert": { $error: { code: "denied", message: "not yours" } } });
  assert.equal($(charterChanged(change({ previous: null })), "[data-act=revert]"), null);
  const c = charterChanged(change());
  click($(c, "[data-act=revert]")); await settle();
  assert.match(text($(c, ".cv-charter-problem")), /did not go through/);
  assert.ok($(c, "[data-act=revert]"));
});

test("dismiss removes the row and tells the caller", () => {
  vyred();
  const wrap = doc.createElement("div"); let gone = 0;
  const c = charterChanged(change(), { onDismiss: () => gone++ });
  wrap.append(c);
  click($(c, "[data-act=dismiss]"));
  assert.equal(gone, 1);
  assert.equal($(wrap, ".cv-charter"), null);
});
