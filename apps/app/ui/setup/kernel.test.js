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

test("a sealed field is stored as kind sealed with its seal (the kernel only seals that kind); one that is already sealed stays sealed", () => {
  const def = { name: "acct", kind: "text", label: "Account" };
  const sealed = applyDraft(def, { ...draftOf(def), sealed: true });
  assert.equal(sealed.kind, "sealed");
  assert.deepEqual(sealed.seal, { level: "ai", class: "free" });
  const own = { name: "ssn", kind: "sealed", label: "SSN", seal: { level: "human", class: "us-ssn" } };
  assert.equal(draftOf(own).sealed, true);
  assert.deepEqual(applyDraft(own, draftOf(own)), own);
  assert.equal(applyDraft(own, { ...draftOf(own), sealed: false }).kind, "sealed", "a sealed field cannot be unsealed here");
});

test("a new field becomes a definition with a name from its label", () => {
  const d = { ...newDraft("text"), label: "Date of birth", group: "Client details" };
  assert.deepEqual(applyDraft(undefined, d), { name: "date_of_birth", kind: "text", label: "Date of birth", group: "Client details" });
});

test("a seal set in the editor round-trips with its level, class, who may reveal and the hint", () => {
  const def = { name: "ssn", kind: "text", label: "SSN" };
  const d = { ...draftOf(def), sealed: true, seal: { level: "human", class: "us-ssn", reveal_roles: ["admin"], hint_allowed: true } };
  const stored = applyDraft(def, d);
  assert.deepEqual(stored.seal, { level: "human", class: "us-ssn", reveal_roles: ["admin"], hint_allowed: true });
  assert.deepEqual(draftOf(stored).seal, d.seal);
  assert.deepEqual(applyDraft(stored, draftOf(stored)), stored);
});

test("an AI-only seal stores no reveal roles and no hint", () => {
  const out = applyDraft({ name: "a", kind: "text", label: "A" }, { ...draftOf({ name: "a", kind: "text", label: "A" }), sealed: true, seal: { level: "ai", class: "free", reveal_roles: ["admin"], hint_allowed: false } });
  assert.deepEqual(out.seal, { level: "ai", class: "free" });
});
