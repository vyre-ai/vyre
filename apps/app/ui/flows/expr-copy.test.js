import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the app's copy of the expression engine is the kernel's, byte for byte", () => {
  const here = new URL("./expr.js", import.meta.url), kernel = new URL("../../../../kernel/flows/expr.js", import.meta.url);
  assert.equal(fs.readFileSync(here, "utf8"), fs.readFileSync(kernel, "utf8"), "copy kernel/flows/expr.js over apps/app/ui/flows/expr.js");
});
