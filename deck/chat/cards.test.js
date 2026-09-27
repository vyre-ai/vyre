// @ts-check
// The question card and the permission card in the fake DOM (deck/test/fake-dom.js), with a fake
// vyred behind fetch and a fake passkey: what each shows, the keys, and exactly what
// threads.answer is called with. Sample world only.

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
    const a = tool in answers ? answers[tool] : { ok: true };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));
const key = k => /** @type {any} */ ({ key: k });

const fx = JSON.parse(readFileSync(new URL("./fixtures/session-blocks.json", import.meta.url), "utf8"));
const { questionCard } = await import("./question.js");
const { askCard } = await import("./ask-item.js");

test("question card: stepper, number keys, multi-select with space, review, Submit sends the answers", async () => {
  const api = vyred();
  const card = questionCard(structuredClone(fx.asks[0]));
  assert.match(text(card), /Vyre asks/);
  assert.match(text(card), /1 of 2/);
  assert.match(text(card), /Which pickup slots should the form offer\?/);
  assert.match(text(card), /7:00 to 11:00/);
  assert.ok($(card, ".cv-q-preview"), "options with previews show a preview panel");
  assert.equal(card.onKey(key("1")), true); // picks "Mornings only" and moves on
  assert.match(text(card), /2 of 2/);
  assert.match(text(card), /Who should get the order emails\?/);
  // Multi-select: arrows move, space toggles; Enter moves on only once something is picked.
  card.onKey(key(" "));   // juno
  card.onKey(key("ArrowDown"));
  card.onKey(key(" "));   // kit
  card.onKey(key(" "));   // kit off again
  card.onKey(key(" "));   // kit on
  assert.equal($$(card, ".cv-q-opt[aria-checked=true]").length, 2);
  card.onKey(key("Enter"));
  assert.match(text(card), /Review/);
  assert.match(text(card), /Mornings only/);
  assert.match(text(card), /juno, kit/);
  card.onKey(key("Escape")); // back a step keeps what was picked
  assert.match(text(card), /2 of 2/);
  assert.equal($$(card, ".cv-q-opt[aria-checked=true]").length, 2);
  card.onKey(key("Enter"));
  card.onKey(key("Enter")); // submit from the review
  await settle();
  const [c] = api.of("threads.answer");
  assert.ok(c, "threads.answer was called");
  assert.equal(c.presence, true);
  assert.deepEqual(c.input, { ask: "ask_q1", decision: "allow", surface: "deck",
    answers: { "Which pickup slots should the form offer?": "Mornings only", "Who should get the order emails?": "juno, kit" } });
  assert.match(text(card), /Answered/);
  assert.equal(card.isOpen(), false);
  assert.equal(card.onKey(key("Enter")), false, "an answered card takes no keys");
});

test("question card: Other takes typed text; Decline sends deny; answered elsewhere folds", async () => {
  const api = vyred();
  const one = { ...structuredClone(fx.asks[0]), id: "ask_q2", questions: [fx.asks[0].questions[0]] };
  const card = questionCard(one);
  assert.doesNotMatch(text(card), /of 1/, "one question: no stepper");
  card.onKey(key("3")); // the Other row
  const input = /** @type {any} */ ($(card, "input.cv-q-input"));
  assert.ok(input, "Other shows a text field");
  input.value = "Saturdays 8 to 12";
  input.dispatchEvent(Object.assign(new Event("input"), { target: input }));
  input.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", target: input, preventDefault() {} }));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input.answers, { "Which pickup slots should the form offer?": "Saturdays 8 to 12" });

  const card2 = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_q3" });
  const decline = $$(card2, "button").find(b => text(b) === "Decline");
  await decline.click();
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_q3", decision: "deny", surface: "deck" });
  assert.match(text(card2), /Declined/);

  const card3 = questionCard({ ...structuredClone(fx.asks[0]), id: "ask_q4" });
  card3.answered("allow", { "Which pickup slots should the form offer?": "All day" });
  assert.match(text(card3), /Slots/);
  assert.match(text(card3), /All day/);
  assert.match(text(card3), /Answered/);
});

test("question card: the event's questions first, previews filled in by update()", () => {
  const bare = structuredClone(fx.asks[0]);
  for (const q of bare.questions) for (const o of q.options) delete o.preview;
  const card = questionCard(bare);
  assert.equal($(card, ".cv-q-preview"), null);
  card.onKey(key("ArrowDown"));
  card.update(structuredClone(fx.asks[0]));
  assert.ok($(card, ".cv-q-preview"));
  assert.match(text($(card, ".cv-q-preview")), /hours\(7, 18\)/, "the focused option's preview");
});

test("permission card: the full command, why, Allow once / Always / Deny with a reason", async () => {
  const api = vyred();
  const card = askCard(structuredClone(fx.asks[1]));
  assert.match(text(card), /Vyre wants to run a command/);
  assert.match(text(card), /\$ npm run deploy -- --site northwind-bakery/);
  assert.match(text(card), /Deploy the order form fix/);
  assert.match(text(card), /Deploying changes the live site\./);
  assert.ok($$(card, "button").some(b => /Always for this/.test(text(b))));
  assert.equal(card.onKey(key("Escape")), true);
  const why = /** @type {any} */ ($(card, "input.cv-why"));
  assert.ok(why, "Esc opens the reason field");
  why.value = "Not before kit checks the kitchen tablet";
  why.dispatchEvent(Object.assign(new Event("input"), { target: why }));
  why.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", target: why, preventDefault() {} }));
  await settle();
  assert.deepEqual(api.of("threads.answer")[0].input, { ask: "ask_p1", decision: "deny", surface: "deck", message: "Not before kit checks the kitchen tablet" });
  assert.match(text(card), /Denied/);

  const c2 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_p2" });
  c2.onKey(key("Enter"));
  await settle();
  assert.deepEqual(api.of("threads.answer")[1].input, { ask: "ask_p2", decision: "allow", surface: "deck" });
  assert.match(text(c2), /Allowed once/);

  const c3 = askCard({ ...structuredClone(fx.asks[1]), id: "ask_p3" });
  await $$(c3, "button").find(b => /Always for this/.test(text(b))).click();
  await settle();
  assert.equal(api.of("threads.answer")[2].input.decision, "always");
  assert.match(text(c3), /Always allowed/);
});

test("permission card: no Always unless offered; an Edit shows its diff; the old event shape still draws", () => {
  vyred();
  const edit = askCard({ id: "ask_e", tool: "Edit", kind: "permission", always: false, reason: null,
    detail: { file: "/home/alex/work/northwind-bakery/src/order/OrderForm.js", old: "a\nb", new: "a\nc" } });
  assert.match(text(edit), /Vyre wants to edit OrderForm\.js/);
  assert.equal($$(edit, "button").some(b => /Always/.test(text(b))), false);
  assert.equal($$(edit, ".cv-dl-del").length, 1);
  assert.equal($$(edit, ".cv-dl-add").length, 1);
  const legacy = askCard({ id: "ask_l", tool: "WebFetch", summary: "fetch https://example.com", destination: "https://example.com", reason: null, agent: "juno" });
  assert.match(text(legacy), /juno wants to fetch a page/);
  assert.match(text(legacy), /https:\/\/example\.com/);
  legacy.answered("cancelled");
  assert.match(text(legacy), /Withdrawn/);
  assert.doesNotMatch(everything(edit) + everything(legacy), /claude/i);
});

test("tool cards: the checklist, a short diff and a run open on their own; a read waits for a tap; Bash shows 6 lines", async () => {
  const { toolCard, personAv, agentAv } = await import("./blocks.js");
  const byTool = t => fx.blocks.find(b => b.tool === t);
  const open = el => el.hasAttribute("data-open");
  assert.equal(open(toolCard(byTool("TodoWrite"))), true);
  assert.equal(open(toolCard(byTool("Edit"))), true);
  const long = { ...byTool("Edit"), input: { file_path: "a.js", old_string: "x\n".repeat(20), new_string: "y\n".repeat(20) } };
  assert.equal(open(toolCard(long)), false, "a long diff waits for a tap");
  assert.equal(open(toolCard(byTool("Read"))), false);
  assert.equal(open(toolCard({ ...byTool("Read"), error: true, output: "no such file" })), true, "a failure opens");
  const bash = toolCard(byTool("Bash"));
  assert.equal(open(bash), true);
  assert.equal(text($(bash, ".cv-out")).split("\n").length, 6);
  assert.match(text(bash), /show all \(7 lines\)/);
  assert.equal(text(personAv("you", "alex")), "A");
  assert.ok($(personAv("you", null), ".cv-dot"));
  assert.equal(text(personAv("capsule")), "C");
  assert.ok($(agentAv("Vyre"), "svg"));
  assert.equal(text(agentAv("juno")), "ju");
});
