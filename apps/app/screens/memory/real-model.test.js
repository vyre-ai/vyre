// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("a fact from memory.facts becomes the screen's fact, in Mine", { skip: !strip }, async () => {
  const { toFact } = await import("./real-model.ts");
  const row = { id: "per:jane|prefers|note:1", text: "Jane Doe prefers email", subject: { id: "per:jane", label: "Jane Doe", kind: "person" }, object: { id: "note:1", label: "email", kind: "note" }, confidence: 0.9, age: "2 d ago", source: "Intake follow-up", ref: { session: "s1" }, evidence: 3, taught: [] };
  const f = toFact(/** @type {any} */ (row));
  assert.deepEqual({ id: f.id, sp: f.sp, subj: f.subj, kind: f.kind, text: f.text, used: f.used, when: f.when, label: f.src.label, k: f.src.kind }, { id: row.id, sp: "mine", subj: "per:jane", kind: "person", text: row.text, used: 3, when: "2 d ago", label: "Intake follow-up", k: "chat" });
  const g = toFact(/** @type {any} */ ({ ...row, subject: { id: "p", label: "Doe estate", kind: "project" }, ref: null, source: null, taught: [{ module: "watcher" }] }));
  assert.equal(g.kind, "project");
  assert.equal(g.src.kind, "flow");
  assert.equal(g.by, "watcher");
});
