// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$, everything } from "../../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
  PublicKeyCredential: function PublicKeyCredential() {},
});
const buf = () => new Uint8Array([1, 2, 3]).buffer;
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true,
  value: { userAgent: "Macintosh", maxTouchPoints: 0, credentials: { get: async () => ({ rawId: buf(), response: { authenticatorData: buf(), clientDataJSON: buf(), signature: buf() } }) } } });

/** A fake vyred: tools by name, every call recorded with whether it carried a presence proof. */
function vyred(answers = {}) {
  const calls = [];
  globalThis.fetch = /** @type {any} */ (async (url, o) => {
    if (String(url).includes("/v1/presence/challenge")) return { status: 200, json: async () => ({ data: { challenge: "ch1", webauthn: { challenge: "AAAA", rpId: "localhost" } } }) };
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const input = JSON.parse(o.body);
    calls.push({ tool, input, presence: !!o.headers["x-vyre-presence"] });
    const a0 = tool in answers ? answers[tool] : { ok: true };
    const a = typeof a0 === "function" ? a0(input) : a0;
    if (a && a.$error) return { status: 409, statusText: "", json: async () => ({ error: a.$error }) };
    return { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
  return { calls, of: t => calls.filter(c => c.tool === t) };
}
const settle = () => new Promise(r => setTimeout(r, 5));

const { draftCard } = await import("./draft.js");
const type = (node, v) => { node.replaceChildren(v); node.dispatchEvent(new /** @type {any} */ (globalThis).Event("input")); };
const mail = (o = {}) => ({ id: "ask-d1", kind: "email_draft", agent: "kit", at: Date.now(), gate: "g-1",
  draft: { to: ["sam@northwind.test"], cc: [], subject: "October numbers", body: "Hi Sam,\n\nTotals attached.", attach: [{ name: "totals.xlsx", size: 412000 }] }, ...o });
const invite = (o = {}) => ({ id: "ask-c1", kind: "calendar_draft", agent: "juno", at: Date.now(), gate: "g-2", said: { id: "s1", turn: 3 },
  draft: { title: "Bakery pricing review", start: "2026-10-02T17:00:00Z", end: "2026-10-02T17:30:00Z", attendees: [{ name: "Sam Reyes", availability: "free" }, { name: "Jo Park", availability: "busy" }, { name: "Ana" }], place: "Video call", notes: "Bring the new price list." }, ...o });

test("email draft: header, the field rows in order, the attachment as a file row, Send and Discard", () => {
  vyred();
  const c = draftCard(mail(), { phone: false });
  assert.equal(c.getAttribute("aria-label"), "Draft to send");
  assert.match(text($(c, ".cv-ask-head")), /Draft to send.*Gate \u00b7 outbound email.*kit/);
  assert.deepEqual($$(c, ".cv-dr-key").map(k => text(k)), ["To", "Cc", "Subject", "Message", "Attach"]);
  assert.equal(text($(c, "[data-field=to]")), "sam@northwind.test");
  assert.equal($(c, "[data-field=subject]").getAttribute("aria-label"), "Subject");
  assert.equal($(c, "[data-field=body]").getAttribute("aria-multiline"), "true");
  assert.match(text($(c, ".cv-dr-file")), /totals\.xlsx\s*402 KB/);
  assert.equal($(c, "[data-act=send]").getAttribute("aria-keyshortcuts"), "Meta+Enter Control+Enter");
  assert.equal($(c, "[data-act=discard]").getAttribute("aria-keyshortcuts"), "D");
  assert.equal($$(c, "button").filter(b => /^Edit/.test(text(b))).length, 0, "no Edit button");
  assert.ok(c.isOpen());
});

test("email draft: an unmatched send is held: Send needs the proof (gate.approve), Send with the person's proof word", async () => {
  const f = vyred();
  const c = draftCard(mail(), { phone: false });
  assert.match(text($(c, "[data-act=send]")), /^Send with Touch ID/);
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  const a = f.of("gate.approve");
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].input, { id: "g-1" });
  assert.equal(a[0].presence, true, "the proof travels with it");
  assert.match(text(c), /Sent to sam@northwind\.test/);
  assert.equal(c.isOpen(), false);
});

test("email draft: a send the person's own turn asked for (said) needs no passkey and no presence line", async () => {
  const f = vyred();
  const c = draftCard(mail({ said: { id: "s1", turn: 2 }, presence: { required: true, covered: false } }), { phone: false });
  assert.match(text($(c, "[data-act=send]")), /^Send\s*\u2318/);
  assert.equal(text($(c, ".cv-dr-cover")), "");
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  assert.equal(f.of("gate.approve").length, 0);
  assert.deepEqual(f.of("threads.answer").map(x => [x.input, x.presence]), [[{ ask: "ask-d1", decision: "allow", surface: "deck" }, false]]);
});

test("email draft: an edit changes the label and travels as `edited` with only the changed fields; retyping the original drops it", async () => {
  const f = vyred();
  const c = draftCard(mail({ said: { id: "s1" } }), { phone: false });
  type($(c, "[data-field=subject]"), "October numbers, revised");
  type($(c, "[data-field=to]"), "sam@northwind.test, jo@northwind.test");
  assert.match(text($(c, "[data-act=send]")), /^Send edited/);
  type($(c, "[data-field=subject]"), "October numbers");
  type($(c, "[data-field=to]"), "sam@northwind.test");
  assert.match(text($(c, "[data-act=send]")), /^Send\s*\u2318/, "no change left");
  type($(c, "[data-field=cc]"), "kit@harlow.test");
  type($(c, "[data-field=to]"), "sam@northwind.test, jo@northwind.test");
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("threads.answer")[0].input.edited, { cc: ["kit@harlow.test"], to: ["sam@northwind.test", "jo@northwind.test"] });
});

test("email draft: an unmatched edit goes to gate.approve as edited; a failed sender keeps the draft held and says why", async () => {
  const f = vyred({ "gate.approve": { state: "failed", error: "mailbox full" } });
  const c = draftCard(mail(), { phone: false });
  type($(c, "[data-field=body]"), "Hi Sam, totals attached.");
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  assert.deepEqual(f.of("gate.approve")[0].input, { id: "g-1", edited: { body: "Hi Sam, totals attached." } });
  assert.match(text(c), /Not sent: mailbox full\. It is still held\. Send tries again\./);
  assert.ok(c.isOpen());
  assert.equal($(c, "[data-act=send]").disabled, false);
});

test("email draft: a refused proof leaves the card open with the reason", async () => {
  vyred({ "gate.approve": { $error: { code: "presence_required", message: "Prove it is you" } } });
  const c = draftCard(mail(), { phone: false });
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  assert.match(text(c), /Prove it is you/);
  assert.ok(c.isOpen());
});

test("email draft: Discard rejects the held item (presence asked); D and Cmd+Enter work from the session; matched Discard denies the ask", async () => {
  const f = vyred();
  const c = draftCard(mail(), { phone: false });
  assert.equal(c.onKey(/** @type {any} */ ({ key: "d" })), true);
  await settle(); await settle();
  assert.deepEqual(f.of("gate.reject").map(x => x.input), [{ id: "g-1" }]);
  assert.match(text(c), /Discarded/);
  const g = vyred();
  const m = draftCard(mail({ id: "ask-d2", said: { id: "s1" } }), { phone: false });
  m.onKey(/** @type {any} */ ({ key: "d" }));
  await settle(); await settle();
  assert.deepEqual(g.of("threads.answer")[0].input, { ask: "ask-d2", decision: "deny", surface: "deck" });
  const k = draftCard(mail({ id: "ask-d3", said: { id: "s1" } }), { phone: false });
  assert.equal(k.onKey(/** @type {any} */ ({ key: "Enter", metaKey: true })), true);
  assert.equal(k.onKey(/** @type {any} */ ({ key: "x" })), false);
});

test("email draft: answered elsewhere closes it and says where", () => {
  vyred();
  const c = draftCard(mail(), { phone: false });
  c.answered("allow", null, { where: "the phone", at: Date.now() });
  assert.match(text(c), /Sent to sam@northwind\.test/);
  assert.match(text(c), /Answered from the phone/);
  assert.equal($$(c, "[data-act=send]").length, 0);
});

test("email draft: From shows only when more than one account can send", () => {
  vyred();
  assert.equal($$(draftCard(mail(), {}), ".cv-dr-key").filter(k => text(k) === "From").length, 0);
  const c = draftCard(mail({ accounts: ["a", "b"], draft: { ...mail().draft, from: "alex@harlow.test" } }), {});
  assert.equal(text($$(c, ".cv-dr-key")[0]), "From");
});

test("calendar invite: Invite to send, title, when in the viewer's zone, people with a word for availability, place, message", () => {
  vyred();
  const c = draftCard(invite(), { phone: false });
  assert.equal(c.getAttribute("aria-label"), "Invite to send");
  assert.match(text($(c, ".cv-ask-head")), /Invite to send.*Gate \u00b7 outbound invite/);
  assert.deepEqual($$(c, ".cv-dr-key").map(k => text(k)), ["Title", "When", "People", "Where", "Message"]);
  assert.match(text($(c, ".cv-dr-when")), /\d\d:\d\d\u2013\d\d:\d\d/);
  assert.equal(text($(c, "[data-field=attendees]")), "Sam Reyes, Jo Park, Ana");
  const rows = $$(c, ".cv-dr-person").map(r => text(r));
  assert.match(rows[0], /Sam Reyes.*free/);
  assert.match(rows[1], /Jo Park.*busy/);
  assert.equal(rows.length, 2, "no mark and no guess for a person the connector could not answer for");
  assert.equal(text($(c, "[data-field=notes]")), "Bring the new price list.");
  assert.match(text($(c, "[data-act=send]")), /^Send invite/);
});

test("calendar invite: a time edit and a people edit go as edited; a matched invite sends with no passkey", async () => {
  const f = vyred();
  const c = draftCard(invite(), { phone: false });
  await $(c, ".cv-dr-when").click();
  const start = $(c, "input[data-field=start]");
  start.value = "2026-10-03T10:00";
  start.dispatchEvent(new /** @type {any} */ (globalThis).Event("change"));
  type($(c, "[data-field=place]"), "Northwind Bakery, back room");
  assert.match(text($(c, "[data-act=send]")), /^Send edited/);
  await $(c, "[data-act=send]").click();
  await settle(); await settle();
  const t = f.of("threads.answer")[0];
  assert.equal(t.presence, false);
  assert.equal(t.input.edited.start, new Date("2026-10-03T10:00").toISOString());
  assert.equal(t.input.edited.place, "Northwind Bakery, back room");
  assert.match(text(c), /Invite sent to Sam Reyes/);
});
