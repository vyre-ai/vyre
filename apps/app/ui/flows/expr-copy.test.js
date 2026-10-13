import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the app's copy of the expression engine is the kernel's, byte for byte", () => {
  const here = new URL("./expr.js", import.meta.url), kernel = new URL("../../../../kernel/flows/expr.js", import.meta.url);
  const body = (f) => fs.readFileSync(f, "utf8").split("\n").slice(1).join("\n"); // line 1 is the type-check pragma
  assert.equal(body(here), body(kernel), "copy kernel/flows/expr.js over apps/app/ui/flows/expr.js");
});
