import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentOf, editedOf, fieldsOf, heldFor, sendOutcome } from "./held.js";

const item = { id: "g1", kind: "send", via: "mail", to: ["sam@example.com"], state: "held", draft: { body: "Hi Sam, the report is attached.", subject: "Q3 report", cc: ["lee@example.com"] }, final: null };

test("held: every text field shows in a steady order, and only a send's text can be edited", () => {
  assert.deepEqual(fieldsOf(item).map((f) => [f.key, f.label, f.edit]), [["subject", "Subject", true], ["body", "Message", true], ["cc", "Cc", false]]);
  assert.equal(fieldsOf(item)[2].value, "lee@example.com");
  assert.equal(fieldsOf({ ...item, kind: "spend" }).some((f) => f.edit), false);
  assert.equal(contentOf({ ...item, final: { body: "edited" } }).body, "edited", "what was last edited, not the draft");
});

test("held: only what changed goes as edited; nothing changed is null", () => {
  assert.equal(editedOf(item, { subject: "Q3 report", body: "Hi Sam, the report is attached." }), null);
  assert.deepEqual(editedOf(item, { body: "Hi Sam." }), { body: "Hi Sam." });
  assert.deepEqual(editedOf(item, { subject: "" }), { subject: "" }, "an emptied field clears it");
  assert.deepEqual(editedOf(item, {}, "sam@example.com, kim@example.com"), { to: ["sam@example.com", "kim@example.com"] });
  assert.equal(editedOf(item, {}, " sam@example.com "), null);
});

test("held: a draft in a chat finds its held item", () => {
  const needs = [
    { id: "gate:g1", source: "gate", thread: "c1", title: "Send email to sam", detail: "Q3 report", at: 10 },
    { id: "gate:g2", source: "gate", thread: "c1", title: "Send email to kim", detail: "Invoice", at: 20 },
    { id: "ask:a1", source: "ask", thread: "c1", title: "Run a command", detail: "ls", at: 30 },
    { id: "gate:g3", source: "gate", thread: "c2", title: "Send email", detail: "Q3 report", at: 40 },
  ];
  assert.equal(heldFor({ subject: "Q3 report" }, needs, "c1"), "gate:g1");
  assert.equal(heldFor({ subject: "Other" }, needs, "c1"), "gate:g2", "else the newest in this chat");
  assert.equal(heldFor({ subject: "x" }, needs, "c9"), null);
});

test("held: the outcome reads as sent or the box's reason", () => {
  assert.deepEqual(sendOutcome({ state: "sent" }), { ok: true });
  assert.deepEqual(sendOutcome({ state: "held", error: "mail host down" }), { ok: false, reason: "mail host down" });
});

test("held: the files on a message are listed by name and size, read only, so the approver sees them", () => {
  const item = { kind: "send", draft: { subject: "Invoice", body: "Attached.", cc: ["juno@harlow.example"], attachments: [{ path: "/Files/invoice.pdf", name: "invoice.pdf", size: 2048, sha256: "ab", by: "alex" }, { name: "rota.txt", bytes: 300 }] } };
  const rows = fieldsOf(item);
  const files = rows.find((r) => r.key === "attachments");
  assert.equal(files.label, "Files");
  assert.equal(files.value, "invoice.pdf (2 KB), rota.txt (1 KB)");
  assert.equal(files.edit, false);
  assert.deepEqual(rows.map((r) => r.key), ["subject", "body", "cc", "attachments"]);
});
