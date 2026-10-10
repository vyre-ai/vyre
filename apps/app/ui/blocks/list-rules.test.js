// A quiet list says a state in plain text, and a state that needs the person is still a chip.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessoryAsChip } from "./list-rules.js";

test("list accessory: a tight list says it plainly unless it needs you; any other list draws a chip", () => {
  assert.equal(accessoryAsChip(true, undefined), false, "settings: the devices count stays plain text");
  assert.equal(accessoryAsChip(true, "plain"), false);
  assert.equal(accessoryAsChip(true, "ok"), false);
  for (const t of ["accent", "warn", "err"]) assert.equal(accessoryAsChip(true, t), true, `${t} is a chip in a tight list`);
  for (const t of [undefined, "plain", "ok", "warn"]) assert.equal(accessoryAsChip(false, t), true, "a default list draws a chip");
});

import { rowExtras } from "./list-rules.js";

test("list row extras: faces, provider marks and several accessories are read as given; a plain row has none, and a dim row says so", () => {
  const plain = rowExtras({ id: "1", title: "t" });
  assert.deepEqual(plain, { faces: [], providers: [], accessories: [], dim: false, actions: [], any: false });
  const x = rowExtras({ faces: [{ kind: "person", name: "Alex" }], providers: ["claude"], accessories: [{ label: "Needs you", tone: "accent" }, { label: "2m", as: "text" }, { label: "3" }], dim: true });
  assert.deepEqual(x.accessories.map((a) => [a.label, a.as, a.tone]), [["Needs you", "chip", "accent"], ["2m", "text", undefined], ["3", "chip", undefined]], "a chip unless it says it is text");
  assert.deepEqual([x.faces.length, x.providers, x.dim, x.any], [1, ["claude"], true, true]);
  assert.equal(rowExtras({ providers: "claude" }).providers.length, 0, "a bad shape draws nothing");
});

test("list row actions: up to four, the first drawn as the button; a kind that is not known is plain, and a broken one is dropped", () => {
  const x = rowExtras({ actions: [{ id: "pause", title: "Pause" }, { id: "remove", title: "Remove Kit", kind: "hold" }, { id: "go", title: "Go", kind: "primary" }, { id: "bad" }, null, { id: "d", title: "D", kind: "danger" }, { id: "e", title: "E" }] });
  assert.deepEqual(x.actions.map((a) => [a.id, a.kind]), [["pause", "plain"], ["remove", "hold"], ["go", "primary"], ["d", "plain"]]);
  assert.equal(x.any, true);
  assert.deepEqual(rowExtras({ faces: [{ kind: "teammate", name: "Dana" }] }).faces.length, 1);
});

test("list row faces keep the id that seeds a person's mark, so a face looks the same as everywhere else", () => {
  assert.deepEqual(rowExtras({ faces: [{ kind: "person", name: "Dana", id: "p2" }, { kind: "person", name: "Sam" }] }).faces, [{ kind: "person", name: "Dana", id: "p2" }, { kind: "person", name: "Sam" }]);
});
