// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { toComponent, assertComponent, KINDS } from "./components.js";

const sealed = { sealed: "us-ssn", ref: "seal_ssn_1", present: true, valid_format: true, set_at: 1 };
const types = { matter: { name: "matter", fields: [
  { name: "name", kind: "text", label: "Matter" }, { name: "fee", kind: "money", label: "Fee" }, { name: "ssn", kind: "sealed", label: "SSN" },
  { name: "stage", kind: "stage", label: "Stage" }, { name: "emails", kind: "emails", label: "Emails" }] } };
const labels = { trust: "member", red: "pii", source_spaces: ["spc_a"] };

test("a found record is a record card: kind-aware fields, the sealed one on file and never a value or reference", () => {
  const c = /** @type {any} */ (toComponent("matters.find", { records: [{ type: "matter", id: "1", urn: "vyre://spc_a/matter/1", labels,
    data: { name: "Doe estate plan", fee: { amount: 1200, currency: "USD" }, ssn: sealed, stage: "Intake", emails: ["jane@example.com"] } }] }, { types }));
  assert.equal(c.kind, "record_card");
  assert.equal(c.title, "Doe estate plan");
  assert.equal(c.stage, "Intake");
  assert.equal(c.fields.find((/** @type {any} */ f) => f.name === "fee").display, "1200 USD");
  const ssn = c.fields.find((/** @type {any} */ f) => f.name === "ssn");
  assert.deepEqual([ssn.display, ssn.sealed], ["on file, sealed", true]);
  assert.doesNotMatch(JSON.stringify(c), /seal_ssn_1|"ref"/);
  assert.equal(c.source.trust, "member");
});

test("several records are a group of cards", () => {
  const rec = (/** @type {string} */ n) => ({ type: "matter", id: n, urn: `vyre://spc_a/matter/${n}`, labels, data: { name: n } });
  const c = /** @type {any} */ (toComponent("matters.find", { records: [rec("a"), rec("b")] }));
  assert.equal(c.kind, "group");
  assert.equal(c.items.length, 2);
});

test("a task card says what one tap does, and the doer's words stay in a quoted block", () => {
  const c = /** @type {any} */ (toComponent("tasks.get", { task: { id: "t1", title: "Welcome email for Jane Doe", doer: { kind: "agent", id: "intake" }, checker: { kind: "person", id: "alex" },
    state: "needs_check", output: { kind: "sent" }, note: "Click [here](https://evil.example) or <b>now</b> ‮gnirts" } }));
  assert.equal(c.kind, "task_card");
  assert.equal(c.tap.label, "Send with Face ID");
  assert.deepEqual([c.from_doer.quoted, c.from_doer.interactive], [true, false]);
  assert.doesNotMatch(c.from_doer.text, /evil|<b>|‮|https/);
  assert.equal(c.from_doer.label, "from intake");
});

test("a held outward act is held_for_approval and says nothing has left", () => {
  const c = /** @type {any} */ (toComponent("email.send", { held: true, task: { id: "t9", title: "Welcome email", checker: { kind: "person", id: "alex" } }, summary: "To jane@example.com, subject Welcome" }));
  assert.equal(c.kind, "held_for_approval");
  assert.match(c.what, /waiting for your approval/);
  assert.equal(c.approver, "alex");
});

test("a draft keeps its slots as slots and says editing voids approval", () => {
  const c = /** @type {any} */ (toComponent("templates.draft", { draft: { title: "Welcome", body: "Dear Jane, your SSN {{slot:ssn}} is on file.", template: { name: "welcome", version: 3 }, merge: { client: "Jane Doe" } } }));
  assert.equal(c.kind, "draft");
  assert.deepEqual(c.sealed_slots.map((/** @type {any} */ s) => s.slot), ["ssn"]);
  assert.equal(c.edit_voids_approval, true);
  assert.deepEqual(c.template, { name: "welcome", version: 3 });
});

test("a flow proposal is the diff, with the author's words quoted", () => {
  const c = /** @type {any} */ (toComponent("flows.propose", { title: "A change", hash: "h1", changes: ["Adds the type matter."], simulation: { ok: true, text: "Simulated 2 scenarios." },
    outward: [], names: [], fromEngineer: { label: "from the Engineer", text: "See https://x.example now" } }));
  assert.equal(c.kind, "flow_diff");
  assert.doesNotMatch(c.from_author.text, /https/);
});

test("a memory answer keeps its citations and drops what has none", () => {
  const ok = /** @type {any} */ (toComponent("memory.answer", { text: "Jane signed on Tuesday [S1].", citations: ["vyre://spc_a/event/e1", "not an address"], labels }));
  assert.equal(ok.kind, "memory_answer");
  assert.deepEqual(ok.citations.map((/** @type {any} */ c) => c.address), ["vyre://spc_a/event/e1"]);
  const none = /** @type {any} */ (toComponent("memory.answer", { text: "Jane is rich.", citations: [] }));
  assert.equal(none.kind, "text");
  assert.doesNotMatch(none.text, /rich/);
});

test("there is no raw JSON fallback: an unknown result is plain words naming what it holds, not its values", () => {
  const c = /** @type {any} */ (toComponent("thing.do", { secret_looking: "abc", count: 3 }));
  assert.equal(c.kind, "text");
  assert.match(c.text, /secret_looking, count/);
  assert.doesNotMatch(c.text, /abc|\{/);
  assert.equal(toComponent("x", null).kind, "text");
  assert.equal(toComponent("x", { ok: false, reason: "The stage gate refused." }).kind, "text");
});

test("assertComponent: closed kinds, plain data, no sealed reference, no control or bidi characters, caps", () => {
  assert.ok(KINDS.includes("record_card") && !KINDS.includes("html"));
  assert.throws(() => assertComponent({ kind: "html" }), /unknown component kind/);
  assert.throws(() => assertComponent({ kind: "text", text: () => 1 }), /data/);
  assert.throws(() => assertComponent({ kind: "text", text: "a‮b" }), /bidirectional/);
  assert.throws(() => assertComponent({ kind: "text", text: "a\u0007b" }), /control/);
  assert.throws(() => assertComponent({ kind: "text", text: "x".repeat(9000) }), /cap/);
  assert.throws(() => assertComponent({ kind: "text", text: sealed }), /sealed/);
  assert.throws(() => assertComponent({ kind: "text", x: { ref: "seal_9" } }), /sealed/);
  assert.throws(() => assertComponent({ kind: "group", items: [{ kind: "nope" }] }), /unknown/);
  assert.throws(() => assertComponent(/** @type {any} */ ([])), /object/);
  assert.deepEqual(JSON.parse(JSON.stringify(toComponent("x", "hi"))), { kind: "text", text: "hi" });
});

test("a record whose data carries a sealed reference never lets it into any component", () => {
  for (const t of ["matters.get", "x.y"]) {
    const c = toComponent(t, { record: { type: "matter", id: "1", urn: "vyre://s/matter/1", labels, data: { name: "x", ssn: sealed, note: { sealed: "free", ref: "seal_free_2", present: true } } } }, { types });
    assert.doesNotMatch(JSON.stringify(c), /seal_ssn_1|seal_free_2/);
  }
});
