// The More menu keeps every action the record page used to show, in the new order.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { recordMenu } from "./record-menu.js";

const ids = (/** @type {{ id: string }[]} */ items) => items.map((i) => i.id);

test("copy, the preview and empty fields come first; rare actions follow; delete is last", () => {
  const items = recordMenu({ id: "PER-0001", agent: false, canAgent: true, showEmpty: false, files: true, dial: true });
  assert.deepEqual(ids(items), ["copy-id", "copy-link", "agent", "empty", "files", "dial", "header", "delete"]);
  assert.equal(items.find((i) => i.id === "files")?.divider, true);
  assert.equal(items.find((i) => i.id === "delete")?.danger, true);
  assert.equal(items.find((i) => i.id === "delete")?.divider, true);
  assert.equal(items.find((i) => i.id === "agent")?.selected, false);
  assert.equal(items.find((i) => i.id === "empty")?.label, "Show empty fields");
  assert.equal(items.find((i) => i.id === "agent")?.label, "Preview what your agent sees");
});

test("the preview hides Show empty fields; a record with no ID omits Copy ID; a joined team has no preview", () => {
  const on = recordMenu({ id: "", agent: true, canAgent: true, showEmpty: true, files: false, dial: false });
  assert.deepEqual(ids(on), ["copy-link", "agent", "header", "delete"]);
  assert.equal(on.find((i) => i.id === "agent")?.selected, true);
  assert.equal(on.find((i) => i.id === "header")?.divider, true);
  assert.equal(on.some((i) => i.id === "empty"), false);
  const joined = recordMenu({ id: "PER-0001", agent: false, canAgent: false, showEmpty: true, files: false, dial: false });
  assert.equal(joined.some((i) => i.id === "agent"), false);
  assert.equal(joined.find((i) => i.id === "empty")?.selected, true);
  assert.equal(joined.find((i) => i.id === "copy-id")?.label, "Copy ID");
});
