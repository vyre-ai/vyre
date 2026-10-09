// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, only, saveName } from "./computer-files.js";

const HOME = "/Users/alex";
test("only Downloads, Desktop and Documents, and nothing that climbs out", () => {
  for (const ok of ["/Users/alex/Downloads/a.pdf", "/Users/alex/Desktop/x/y.txt", "/Users/alex/Documents", "/Users/alex/Downloads/../Downloads/a.pdf"]) assert.equal(allowed(ok, HOME), true, ok);
  for (const no of ["/Users/alex/Downloads/../.ssh/id", "/Users/alex/Library/x", "/Users/alex/DownloadsEvil/a", "/Users/alex", "/etc/passwd", "Downloads/a", "", null, "/Users/alex/Downloads/a\0"]) assert.equal(allowed(no, HOME), false, String(no));
});
test("search results are cut to the folders; saved names do not climb", () => {
  assert.deepEqual(only([{ path: "/Users/alex/Downloads/a.pdf" }, { path: "/Users/alex/Library/b" }, null], HOME), [{ path: "/Users/alex/Downloads/a.pdf" }]);
  assert.equal(saveName("/Users/alex/Downloads/../x/.hidden.pdf"), "hidden.pdf");
  assert.equal(saveName("/"), "file");
});
