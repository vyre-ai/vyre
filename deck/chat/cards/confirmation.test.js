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

const { confirmationLine, lineOf, canUndo } = await import("./confirmation.js");
const sent = (o = {}) => ({ what: "Sent to the team", to: "3 recipients", at: Date.now(), said: { turn: "t-12", text: "email the team the new pumpkin loaf prices" },
  undo: { tool: "gate.undo_send", input: { send: "s-1" }, until: Date.now() + 60_000 }, ...o });

test("confirmation: a plain row with a check, the line, Undo and You said to; not blocking", () => {
  vyred();
  const c = confirmationLine(sent(), {});
  assert.equal(c.getAttribute("aria-live"), "polite");
  assert.equal(text($(c, ".cv-confirm-line")), "Sent to the team · 3 recipients");
  assert.equal($(c, "[data-act=undo]") != null, true);
  assert.equal($(c, "[data-act=said]") != null, true);
  assert.equal($(c, ".cv-confirm-row").getAttribute("data-turn"), "t-12");
  assert.equal($$(c, ".btn-primary").length, 0, "nothing here approves");
  assert.equal(c.isOpen(), false);
  assert.equal(c.onKey(key("Enter")), false);
  assert.equal(lineOf({ line: "Posted to #updates" }), "Posted to #updates");
});

test("confirmation: You said to opens the matched words inline; Show in thread calls ctx.goto with the turn", async () => {
  vyred();
  const went = [];
  const c = confirmationLine(sent(), { goto: t => went.push(t) });
  assert.equal($(c, ".cv-confirm-quote"), null);
  await $(c, "[data-act=said]").click();
  assert.match(text($(c, ".cv-confirm-said")), /email the team the new pumpkin loaf prices/);
  await $(c, "[data-act=goto]").click();
  assert.deepEqual(went, ["t-12"]);
  const opened = [];
  const d = confirmationLine(sent({ said: { text: "post it", href: "/t/x#12" } }), { open: h => opened.push(h) });
  await $(d, "[data-act=said]").click();
  await $(d, "[data-act=goto]").click();
  assert.deepEqual(opened, ["/t/x#12"]);
});

test("confirmation: Undo calls the queued tool from the payload, then the line reads Undone in place", async () => {
  const f = vyred();
  const c = confirmationLine(sent(), {});
  $(c, "[data-act=undo]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("gate.undo_send").map(x => x.input), [{ send: "s-1" }]);
  assert.equal(text($(c, ".cv-confirm-line")), "Undone · was sent to the team · 3 recipients");
  assert.equal($(c, "[data-act=undo]"), null);
});

test("confirmation: a failed undo says so and keeps Undo; no undo or a closed window shows no Undo", async () => {
  vyred({ "gate.undo_send": { $error: { code: "gone", message: "Already delivered" } } });
  const c = confirmationLine(sent(), {});
  $(c, "[data-act=undo]").click();
  await settle(); await settle();
  assert.match(text($(c, ".cv-confirm-problem")), /Could not undo\. Already delivered/);
  assert.equal($(c, "[data-act=undo]") != null, true);
  assert.equal($(confirmationLine(sent({ undo: undefined }), {}), "[data-act=undo]"), null);
  assert.equal($(confirmationLine(sent({ undo: { tool: "gate.undo_send", until: Date.now() - 1 } }), {}), "[data-act=undo]"), null);
  assert.equal(canUndo(sent({ undo: { tool: "x" } })), true, "no end means no window limit");
});

test("confirmation: the Undo button leaves by itself when its window closes", async () => {
  vyred();
  const c = confirmationLine(sent({ undo: { tool: "gate.undo_send", until: Date.now() + 30 } }), {});
  assert.equal($(c, "[data-act=undo]") != null, true);
  await new Promise(r => setTimeout(r, 80));
  assert.equal($(c, "[data-act=undo]"), null);
});

test("confirmation: several sends in one turn collapse to one line; Show what opens the individual lines", async () => {
  vyred();
  const c = confirmationLine({ at: Date.now(), said: { turn: "t-9", text: "send the update everywhere" }, items: [
    { line: "Sent to the team" }, { line: "Posted to #updates" }, { line: "Scheduled the meeting for Thursday" }] }, {});
  assert.equal(text($(c, ".cv-confirm-line")), "3 things sent");
  assert.equal($$(c, ".cv-confirm-row").length, 1);
  await $(c, "[data-act=show]").click();
  assert.equal($$(c, ".cv-confirm-list .cv-confirm-row").length, 3);
  assert.match(text(c), /Posted to #updates/);
  assert.equal($$(c, ".cv-confirm-row").length, 4);
});
