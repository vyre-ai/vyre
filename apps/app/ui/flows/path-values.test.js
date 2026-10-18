import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { otherLaneSteps, valueSourcesByPath } from "./logic.js";
import { insertList } from "./template.js";
import { SAMPLE_OPTIONS as O } from "../../screens/flows/starters.js";

const options = { ...O, types: [{ name: "contact", label: "Contact", fields: [{ name: "name", label: "Name", kind: "text" }] }] };
const flow = () => ({ name: "P", trigger: { kind: "created", type: "contact" }, steps: [
  { id: "find1", kind: "find", type: "contact", where: "", limit: 5 },
  { id: "decide2", kind: "decide", cond: { mode: "formula", formula: "true" },
    then: [{ id: "create3", kind: "create", type: "contact", fields: [{ field: "name", value: "A" }] }],
    else: [{ id: "create4", kind: "create", type: "contact", fields: [{ field: "name", value: "B" }] }] },
  { id: "email5", kind: "email", to: "a@b.c", subject: "s", body: "b" },
] });

test("a step in the Otherwise lane sees the Then lane's values only as 'may be empty'", () => {
  const m = otherLaneSteps(flow(), "create4");
  assert.deepEqual([...m.entries()], [["create3", "Then"]]);
  const v = valueSourcesByPath(flow(), "create4", options);
  assert.ok(v.always.some(([t]) => t.includes("find1")));
  assert.ok(v.maybe.every(([, , lane]) => lane === "Then"));
  assert.ok(v.maybe.some(([t]) => t.includes("create3")));
  assert.ok(!v.always.some(([t]) => t.includes("create3")));
});

test("after the If, both lanes' values are 'may be empty' and the earlier ones are certain", () => {
  const v = valueSourcesByPath(flow(), "email5", options);
  assert.deepEqual([...new Set(v.maybe.map((x) => x[2]))].sort(), ["Otherwise", "Then"]);
  assert.ok(v.always.some(([t]) => t.includes("find1")));
});

test("the insert list puts the other lane's values in their own group, named for the path", () => {
  const groups = insertList(flow(), "create4", options);
  const g = groups.find((x) => x.maybe);
  assert.ok(g, "a group for values that may be empty");
  assert.equal(g.maybe, "Then");
  assert.ok(!groups.filter((x) => !x.maybe).some((x) => x.title.includes("create3")));
});
