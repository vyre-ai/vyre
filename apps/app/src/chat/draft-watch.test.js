// The draft a "Turn this into a Flow" makes: found as the Flow that was not there before the tap, and told in plain words.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { newDraft, draftWords, flowsFrom } from "./draft-watch.js";

test("draft: the first Flow that was not there before the tap is the one; none yet is null; a name stands in for a missing label", () => {
  const rows = [{ id: "a", label: "Old one" }, { id: "b", label: "Open a matter" }, { id: "c", name: "second" }];
  assert.deepEqual(newDraft(["a"], rows), { id: "b", title: "Open a matter" });
  assert.deepEqual(newDraft(["a", "b"], rows), { id: "c", title: "second" });
  assert.equal(newDraft(["a", "b", "c"], rows), null);
  assert.equal(newDraft([], []), null);
  assert.deepEqual(newDraft([], [{ id: "z" }]), { id: "z", title: "A new Flow" });
  assert.equal(newDraft(["a"], null), null);
});

test("draft words: making, ready and none, plain", () => {
  assert.match(draftWords({ kind: "making" }), /^Making the Flow draft\./);
  assert.equal(draftWords({ kind: "ready", title: "Open a matter" }), "Draft ready: Open a matter. Open it to read the steps and say yes.");
  assert.match(draftWords({ kind: "none" }), /^No Flow was made\./);
});

test("flows from the definitions: one per Flow id, the label from the body, the name when there is none, broken rows skipped", () => {
  const row = (/** @type {string} */ id, /** @type {any} */ body, name = "n") => ({ type: "def-flow", id: `r${id}${Math.random()}`, data: { flow_id: id, name, body: typeof body === "string" ? body : JSON.stringify(body) } });
  const out = flowsFrom({ rows: [row("f1", { label: "Open a matter" }), row("f1", { label: "Open a matter v2" }), row("f2", {}, "second"), row("f3", "{broken"), { data: {} }, null] });
  assert.deepEqual(out, [{ id: "f1", label: "Open a matter v2" }, { id: "f2", label: "second" }, { id: "f3", label: "n" }]);
  assert.deepEqual(flowsFrom(null), []);
  assert.deepEqual(flowsFrom([row("z", { label: "Z" })]), [{ id: "z", label: "Z" }]);
});
