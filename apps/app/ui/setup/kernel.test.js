// A field as the kernel stores it and as the editor holds it: draftOf reads it, applyDraft writes it back onto the original so nothing the editor does not show is lost.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { draftOf, applyDraft, newDraft } from "./logic.js";

test("a stored field reads into a draft and back unchanged", () => {
  const def = { name: "kind", kind: "choice", label: "Kind", required: true, options: ["A", "B"], hidden_from: ["intake"], group: "Details", description: "d" };
  assert.deepEqual(applyDraft(def, draftOf(def)), def);
});

test("a link keeps its inverse name and many", () => {
  const def = { name: "client", kind: "link", label: "Client", to: "contact", many: true, inverse: { name: "assets", label: "Assets" } };
  const d = draftOf(def);
  assert.equal(d.inverse, "Assets");
  assert.deepEqual(applyDraft(def, d), def);
});

test("switching a setting off removes it, and what the editor does not show is kept", () => {
  const def = { name: "fee", kind: "money", label: "Fee", required: true, computed: { expr: "1" }, owned_by: "kernel", hidden_from: ["a"] };
  const out = applyDraft(def, { ...draftOf(def), required: false, hidden_from: [] });
  assert.equal("required" in out, false);
  assert.equal("hidden_from" in out, false);
  assert.deepEqual(out.computed, { expr: "1" });
  assert.equal(out.owned_by, "kernel");
});

test("sealing keeps the kind and adds the seal; unsealing takes it off, but a kind sealed field stays sealed", () => {
  const def = { name: "acct", kind: "text", label: "Account" };
  const sealed = applyDraft(def, { ...draftOf(def), sealed: true });
  assert.equal(sealed.kind, "text");
  assert.deepEqual(sealed.seal, { level: "ai", class: "free" });
  assert.equal("seal" in applyDraft(sealed, { ...draftOf(sealed), sealed: false }), false);
  const own = { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "human", class: "us-ssn" } };
  assert.equal(draftOf(own).sealed, true);
  assert.deepEqual(applyDraft(own, draftOf(own)), own);
});

test("a new field becomes a definition with a name from its label", () => {
  const d = { ...newDraft("text"), label: "Date of birth", group: "Client details" };
  assert.deepEqual(applyDraft(undefined, d), { name: "date_of_birth", kind: "text", label: "Date of birth", group: "Client details" });
});
