// FOUNDATION A5: the lists a surface needs from an owner are generated from it (scripts/gen-surface-lists.mjs), so they cannot drift: each written file is exactly what the generator makes now.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, files, spaceTools } from "../scripts/lib/surface-lists.mjs";

test("A5: the Deck's and the app's generated lists are current (run node scripts/gen-surface-lists.mjs)", () => {
  for (const [f, text] of Object.entries(files())) assert.equal(fs.readFileSync(path.join(ROOT, f), "utf8"), text, `${f} is stale`);
});

test("A5: the tools that take a space are read from the tool reference, and a tool without one is not in the list", () => {
  const md = "\n### `a.one`\n\nx\n\n- Input:\n  - `id` string, required\n  - `space` string\n- Callers: `cli`\n\n### `a.two`\n\ny\n\n- Input:\n  - `id` string\n- Callers: `cli`\n\n### `a.three`\n\nz\n\n- Callers: `cli`\n";
  assert.deepEqual(spaceTools(md), ["a.one"]);
  assert.ok(spaceTools(fs.readFileSync(path.join(ROOT, "docs/reference/tools.md"), "utf8")).includes("records.list"));
});
