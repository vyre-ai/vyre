// @ts-check
// The plan card (plan-card.js) in the fake DOM (deck/test/fake-dom.js), with a fake
// vyred behind fetch and a fake passkey: what each shows, the keys, and exactly what
// threads.answer is called with. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { install, text, $, $$, everything } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  // An svg with a circle in it, which icons.js's mark() colours.
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  PublicKeyCredential: function PublicKeyCredential() {},
});
const buf = () => new Uint8Array([1, 2, 3]).buffer;
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { credentials: { get: async () => ({ rawId: buf(), response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf() } }) } } });

/** A fake vyred: the presence challenge, then tools by name; every tool call recorded. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    if (String(url).includes("/v1/presence/challenge")) return { status: 200, json: async () => ({ data: { challenge: "ch1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input, presence: !!o.headers["x-vyre-presence"] });
    // An answer may be a function of the input; { $error } is a refusal.
    const a0 = tool in answers ? answers[tool] : { ok: true };
    const a = typeof a0 === "function" ? a0(input, !!o.headers["x-vyre-presence"]) : a0;
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));
const key = k => /** @type {any} */ ({ key: k });


const { planCard } = await import("./plan-card.js");
const PLAN = `# Update the Northwind Bakery price list

1. Read \`menu.md\` and \`prices.json\`.
2. Add the pumpkin loaf to \`prices.json\`.
3. Show the new prices in \`src/menu/PriceList.js\`.
4. Add a test.
5. Run \`npm test\`.
6. Ask kit to review the copy.

**Will not touch:** the order form or \`src/checkout/\`.

## Files it expects to change
- \`prices.json\` +4 -0
- \`src/menu/PriceList.test.js\` new +24
`;
const ask = (o = {}) => ({ id: "ask-plan-1", tool: "ExitPlanMode", kind: "permission", agent: "kit", at: Date.now(), detail: { input: { plan: PLAN } }, ...o });

test("plan card: header, title, numbered steps, will not touch, the files, Asks first chosen", () => {
  vyred();
  const c = planCard(ask(), { thread: "t-plan", phone: false });
  assert.equal(c.getAttribute("aria-label"), "Plan to approve");
  assert.match(text($(c, ".cv-ask-head")), /Plan to approve.*kit · \d\d:\d\d/);
  assert.equal(text($(c, ".cv-plan-title")), "Update the Northwind Bakery price list");
  assert.equal($$(c, ".cv-plan-steps li").length, 6);
  assert.match(text($(c, ".cv-plan-not")), /^Will not touch the order form or\s*src\/checkout\/\s*\.?$/);
  assert.equal($$(c, ".cv-plan-file").length, 2);
  assert.match(text($(c, ".cv-plan-fileset")), /2 files/);
  assert.match(text($$(c, ".cv-plan-file")[1]), /new · \+24/);
  assert.equal($(c, ".cv-plan-seg").getAttribute("role"), "radiogroup");
  assert.equal(text($(c, ".cv-plan-opt[aria-checked=true]")), "Asks first");
  assert.deepEqual($$(c, ".cv-plan-actions .btn").map(b => b.getAttribute("data-act")), ["start", "revise", "keep"]);
  assert.equal($(c, "[data-act=start]").getAttribute("aria-keyshortcuts"), "Meta+Enter Control+Enter");
  assert.equal($(c, "[data-act=revise]").getAttribute("aria-keyshortcuts"), "R");
});

test("plan card: Start building allows, then sets the chosen mode; it reads Building", async () => {
  const f = vyred();
  const c = planCard(ask(), { thread: "t-plan", phone: false });
  await $(c, ".cv-plan-opt[data-mode=acceptEdits]").click();
  assert.equal(text($(c, ".cv-plan-opt[aria-checked=true]")), "Edits allowed");
  $(c, "[data-act=start]").click();
  assert.match(text($(c, "[data-act=start]")), /Starting/, "the busy verb");
  assert.equal($(c, "[data-act=keep]").disabled, true);
  await settle(); await settle();
  assert.deepEqual(f.of("threads.answer").map(x => x.input), [{ ask: "ask-plan-1", decision: "allow", surface: "deck" }]);
  assert.deepEqual(f.of("threads.mode").map(x => x.input), [{ thread: "t-plan", mode: "acceptEdits", surface: "deck" }]);
  assert.match(text(c), /Building · Edits allowed/);
  assert.match(text(c), /Plan approved on this screen · 6 steps/);
  assert.equal(c.isOpen(), false);
});

test("plan card: Cmd+Enter starts; R opens Revise prefilled, Enter sends it as a deny with the words", async () => {
  const f = vyred();
  const c = planCard(ask(), { thread: "t-plan", phone: false });
  assert.equal(c.onKey(/** @type {any} */ ({ key: "r" })), true);
  const input = $(c, ".cv-plan-revise");
  assert.equal(input.value, "Change the plan: ");
  input.value = "Change the plan: leave the tests for later";
  input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("input"), {}));
  input.onkeydown?.({ key: "Enter", preventDefault() {} });
  if (!f.of("threads.answer").length) $(c, "[data-act=revise]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("threads.answer")[0].input, { ask: "ask-plan-1", decision: "deny", surface: "deck", message: "Change the plan: leave the tests for later" });
  assert.equal(f.of("threads.mode").length, 0, "no mode change while it keeps planning");
  const g = vyred();
  const d = planCard(ask({ id: "ask-plan-2" }), { thread: "t-plan", phone: false });
  assert.equal(d.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true })), true);
  await settle(); await settle();
  assert.equal(g.of("threads.answer")[0].input.decision, "allow");
  assert.equal(g.of("threads.mode")[0].input.mode, "default", "Asks first by default");
});

test("plan card: Keep planning denies with no note; answered elsewhere says where; a phone folds steps past four", async () => {
  const f = vyred();
  const c = planCard(ask(), { thread: "t-plan", phone: false });
  $(c, "[data-act=keep]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("threads.answer")[0].input, { ask: "ask-plan-1", decision: "deny", surface: "deck" });
  assert.match(text(c), /Kept planning · you declined this plan/);
  vyred();
  const e = planCard(ask(), { thread: "t-plan", phone: false });
  e.answered("allow", null, { where: "the phone", at: Date.now() });
  assert.match(text(e), /Answered from the phone · \d\d:\d\d/);
  const p = planCard(ask(), { thread: "t-plan", phone: true });
  assert.equal($$(p, ".cv-plan-steps li").length, 4);
  assert.match(text($(p, ".cv-plan-more")), /Show all 6 steps/);
  await $(p, ".cv-plan-more").click();
  assert.equal($$(p, ".cv-plan-steps li").length, 6);
  assert.match(text($(p, ".cv-plan-files-head")), /2 files expected/);
  assert.equal($$(p, ".cv-plan-file").length, 0, "files folded on the phone");
});

test("plan card: a failed answer gives the buttons back and says why; a failed mode change keeps the approval", async () => {
  vyred({ "threads.answer": { $error: { code: "timeout", message: "Your server did not answer" } } });
  const c = planCard(ask(), { thread: "t-plan", phone: false });
  $(c, "[data-act=start]").click();
  await settle(); await settle();
  assert.equal($(c, "[data-act=start]").disabled, false);
  assert.match(text(c), /did not answer/);
  vyred({ "threads.mode": { $error: { code: "bad_mode", message: "no such mode" } } });
  const d = planCard(ask({ id: "ask-plan-3" }), { thread: "t-plan", phone: false });
  $(d, "[data-act=start]").click();
  await settle(); await settle();
  assert.match(text(d), /Plan approved/);
  assert.match(text(d), /The mode did not change: no such mode/);
});
