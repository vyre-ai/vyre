// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  PublicKeyCredential: function PublicKeyCredential() {},
});
/** A fake vyred: tools by name, every call recorded. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    calls.push({ tool, input: JSON.parse(o.body), presence: !!o.headers["x-vyre-presence"] });
    const a = tool in answers ? answers[tool] : { ok: true };
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));
const key = k => /** @type {any} */ ({ key: k });

const { surveyCard, isSurvey, thoughtsMap } = await import("./survey.js");
const ask = (o = {}) => ({ id: "ask-sv-1", kind: "survey", agent: "kit", at: Date.now(), questions: [
  { question: "Which flow should new members see?", header: "Flow", options: [
    { label: "Guided", description: "Step by step", recommended: true }, { label: "Self-serve" }] },
  { question: "Which channels?", header: "Channels", multiSelect: true, options: [{ label: "Email" }, { label: "Text" }, { label: "Post", recommended: true }, { label: "Also", recommended: true }] },
], ...o });

test("survey: header, progress bar, one Recommended tag per question, thoughts box always shown, nothing preselected", () => {
  vyred();
  const c = surveyCard(ask(), {});
  assert.equal(c.getAttribute("aria-label"), "Survey from kit");
  assert.equal(text($(c, ".cv-ask-kind")), "Question");
  assert.equal(text($(c, ".cv-q-step")), "1 of 2");
  assert.equal($(c, ".cv-sv-progress").getAttribute("aria-valuenow"), "0");
  assert.equal($(c, ".cv-sv-fill").style.width, "0%");
  assert.equal($$(c, ".cv-sv-rec").length, 1);
  assert.match(text($(c, ".cv-choice")), /Guided.*Step by step.*Recommended/);
  assert.equal($$(c, "[aria-checked=true]").length, 0, "a recommendation is a hint, not a default");
  assert.equal($(c, ".cv-sv-box").getAttribute("placeholder"), "Add your thoughts (optional)");
  assert.equal($(c, "[data-act=submit]").disabled, true);
});

test("survey: two Recommended flags on one question show only the first", () => {
  const c = surveyCard(ask(), {});
  c.onKey(key("1"));
  assert.equal($$(c, ".cv-sv-rec").length, 1);
  assert.match(text($(c, ".cv-q-text")), /Which channels/);
  assert.equal($(c, ".cv-sv-rec").parentNode.getAttribute("aria-checked"), "false");
  assert.match(text($$(c, ".cv-choice")[2]), /Recommended/);
});

test("survey: picking and moving on fills the bar; review shows answers and thoughts; Submit is one batch", async () => {
  const f = vyred();
  const c = surveyCard(ask(), {});
  $(c, ".cv-sv-box").value = "Guided suits the bakery staff";
  $(c, ".cv-sv-box").dispatchEvent(new /** @type {any} */ (globalThis).Event("input"));
  assert.equal(c.onKey(key("1")), true); // picks Guided, moves on, thoughts kept
  assert.equal($(c, ".cv-sv-progress").getAttribute("aria-valuenow"), "1");
  assert.equal($(c, ".cv-sv-fill").style.width, "50%");
  assert.match(text($(c, ".cv-q-step")), /2 of 2/);
  c.onKey(key("1")); c.onKey(key("2")); // multi-select toggles
  assert.equal(c.onKey(key("Enter")), true); // to review
  assert.match(text($(c, ".cv-q-step")), /Review/);
  assert.match(text($(c, ".cv-q-review")), /Guided.*Guided suits the bakery staff/);
  assert.match(text($(c, ".cv-q-review")), /Email, Text/);
  assert.equal(f.of("threads.answer").length, 0, "nothing sent before the last step");
  assert.equal(c.onKey(key("Enter")), true);
  assert.match(text($(c, "[data-act=submit]")), /Sending/);
  await settle(); await settle();
  assert.deepEqual(f.of("threads.answer").map(x => x.input), [{ ask: "ask-sv-1", decision: "allow", surface: "deck",
    answers: { "Which flow should new members see?": "Guided", "Which channels?": "Email, Text" },
    thoughts: { "Which flow should new members see?": "Guided suits the bakery staff" } }]);
  assert.equal(f.of("threads.answer")[0].presence, false, "no passkey");
  assert.match(text(c), /Answered/);
  assert.match(text(c), /Guided suits the bakery staff/);
  assert.equal(c.isOpen(), false);
});

test("survey: thoughts is left out when no box has words; both a choice and thoughts may be set", async () => {
  const f = vyred();
  const c = surveyCard(ask({ questions: [ask().questions[0]] }), {});
  assert.equal($(c, ".cv-sv-progress"), null, "one question needs no bar");
  c.onKey(key("2"));
  await settle(); await settle();
  assert.equal("thoughts" in f.of("threads.answer")[0].input, false);
  assert.deepEqual(thoughtsMap([{ question: "a" }, { question: "b" }], ["  ", " hi "]), { b: "hi" });
});

test("survey: keys are left to the thoughts box while it has focus; Decline denies; a failure keeps the picks", async () => {
  const f = vyred({ "threads.answer": { $error: { code: "timeout", message: "Your server did not answer" } } });
  const c = surveyCard(ask({ questions: [ask().questions[0]] }), {});
  /** @type {any} */ (globalThis.document).activeElement = $(c, ".cv-sv-box");
  assert.equal(c.onKey(key("1")), false);
  /** @type {any} */ (globalThis.document).activeElement = null;
  c.onKey(key("1"));
  await settle(); await settle();
  assert.match(text(c), /did not answer|That did not go through/i);
  assert.equal($(c, "[aria-checked=true]") != null, true, "choices stay picked");
  assert.equal(c.isOpen(), true);
  const g = vyred();
  const d = surveyCard(ask(), {});
  await $(d, "[data-act=decline]").click();
  await settle(); await settle();
  assert.deepEqual(g.of("threads.answer")[0].input, { ask: "ask-sv-1", decision: "deny", surface: "deck" });
  assert.match(text(d), /Declined/);
});

test("survey: answered elsewhere says where; isSurvey picks up a plain question with the extras", () => {
  const c = surveyCard(ask(), {});
  c.answered("allow", { "Which flow should new members see?": "Self-serve" }, { where: "the phone", at: Date.now() });
  assert.match(text(c), /Self-serve/);
  assert.match(text(c), /Answered from the phone/);
  const q = { kind: "question", questions: [{ question: "q", options: [{ label: "a" }] }] };
  assert.equal(isSurvey(q), false);
  assert.equal(isSurvey({ ...q, survey: true }), true);
  assert.equal(isSurvey({ kind: "survey" }), true);
  assert.equal(isSurvey({ ...q, questions: [{ question: "q", options: [{ label: "a", recommended: true }] }] }), true);
  assert.equal(isSurvey({ ...q, questions: [{ question: "q", thoughts: "", options: [] }] }), true);
});
