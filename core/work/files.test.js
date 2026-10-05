import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeName } from "./files.js";

test("a file name is one safe path segment, with its extension kept", () => {
  assert.equal(safeName("../../etc/passwd"), "passwd");
  assert.equal(safeName("a\\b\\c.png"), "c.png");
  assert.equal(safeName(".hidden"), "hidden");
  assert.equal(safeName("  site   photo .png "), "site photo .png");
  assert.equal(safeName("line\nbreak\u0000.txt"), "linebreak.txt");
  assert.equal(safeName(""), "file");
  assert.equal(safeName("", "image"), "image");
  const long = safeName("x".repeat(300) + ".pdf");
  assert.ok(long.length <= 120 && long.endsWith(".pdf"));
});
