// R031-58 (the design checker): the app's screens take colour, type and layout from @vyre/ui and its tokens. apps/app/scripts/check-design-rules.mjs counts the literals, StyleSheets and second-primitive
// imports per file; design-rules.baseline.json holds what is there today. A file may not go over its count and a file not in the baseline may not start, so the look stays one look without a reviewer.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, problems, stale, readBaseline, RULES } from "../apps/app/scripts/check-design-rules.mjs";

test("design rules: no screen is over its baseline (a literal colour, a hand-set font, a StyleSheet, a second primitive); fix the screen, never raise the baseline", () => {
  assert.deepEqual(problems(scan(), readBaseline()), [], "use @vyre/ui and its tokens: see the rule list at the top of apps/app/scripts/check-design-rules.mjs");
});

test("design rules: the baseline names only files that still break a rule at that count or fewer (entries the code outgrew are named, lowered with --update)", () => {
  const old = stale(scan(), readBaseline());
  if (old.length) console.log(`design rules: ${old.length} baseline entries can go down (node apps/app/scripts/check-design-rules.mjs --update):\n  ${old.join("\n  ")}`);
  const baseline = readBaseline();
  for (const [file, counts] of Object.entries(baseline)) assert.ok(fs.existsSync(path.join("apps/app", file)), `${file} is in the baseline but gone: run check-design-rules.mjs --update`), assert.ok(Object.values(counts).every((n) => /** @type {number} */ (n) > 0));
});

test("design rules: each rule finds its own case and leaves the ordinary alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "design-rules-"));
  fs.mkdirSync(path.join(dir, "screens"));
  fs.writeFileSync(path.join(dir, "screens", "x.tsx"), [
    `import { Button } from "@vyre/ui";`,
    `import { Row } from "../../src/ui/Row";`,
    `// a comment with #ff0000 and fontSize: 12 is not code`,
    `const a = { color: "#1a2b3c", fontSize: 13 };`,
    `const b = StyleSheet.create({ x: { flex: 1 } });`,
    `const c = "https://example.test/#section";`,
    `const d = color["accent"];`,
  ].join("\n"));
  assert.deepEqual(scan(dir), { "screens/x.tsx": { "raw-colour": 1, "type-literal": 1, "style-sheet": 1, "second-primitive": 1 } });
  assert.deepEqual(problems(scan(dir), {}).length, 4);
  assert.deepEqual(problems(scan(dir), { "screens/x.tsx": { "raw-colour": 1, "type-literal": 1, "style-sheet": 1, "second-primitive": 1 } }), []);
  assert.deepEqual(RULES.map((r) => r.id), ["raw-colour", "type-literal", "style-sheet", "second-primitive"]);
  fs.rmSync(dir, { recursive: true });
});
