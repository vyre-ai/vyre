import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SPACE_TOOLS, withSpace } from "./with-space.js";

const A = "spc_abcdefghijkl", B = "spc_mnopqrstuvwx";

test("a tool that takes a space gets the showing one", () => {
  assert.deepEqual(withSpace("records.list", { type: "contact" }, A), { type: "contact", space: A });
  assert.deepEqual(withSpace("tasks.list", undefined, A), { space: A });
  assert.deepEqual(withSpace("rules.enable", { id: "r1" }, A), { id: "r1", space: A });
});

test("a screen's own space wins, and All spaces or no space adds nothing", () => {
  assert.deepEqual(withSpace("records.list", { space: B }, A), { space: B });
  assert.deepEqual(withSpace("records.list", { type: "x" }, "all"), { type: "x" });
  assert.deepEqual(withSpace("records.list", {}, undefined), {});
});

test("a tool that does not take a space is left alone", () => {
  for (const t of ["records.get", "records.update", "files.drive.list", "spaces.list", "vault.list"]) assert.deepEqual(withSpace(t, { id: "x" }, A), { id: "x" }, t);
  assert.equal(SPACE_TOOLS.size, 34);
});
