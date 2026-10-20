// A long list draws its first rows and says how many more it can show.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW, windowOf } from "./windowing.js";

test("a long list draws a window, a short one draws whole", () => {
  const rows = Array.from({ length: 250 }, (_, i) => i);
  const a = windowOf(rows);
  assert.equal(a.rows.length, WINDOW);
  assert.equal(a.more, 150);
  assert.equal(a.label, "Show 100 more");
  const b = windowOf(rows, 200);
  assert.equal(b.rows.length, 200);
  assert.equal(b.label, "Show 50 more");
  const c = windowOf(rows.slice(0, 20));
  assert.equal(c.more, 0);
  assert.equal(c.label, "");
  assert.equal(windowOf(/** @type {any} */ (null)).rows.length, 0);
});

test("the table, the board and the gallery draw through the window", async () => {
  const fs = await import("node:fs");
  for (const f of ["../blocks/TypedTable.tsx", "./GalleryView.tsx", "../components/BoardStacked.tsx", "../components/BoardWeb.tsx"]) {
    assert.match(fs.readFileSync(new URL(f, import.meta.url), "utf8"), /windowOf\(/, `${f} draws a window`);
  }
});
