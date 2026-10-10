// The design checker's own test (apps/app/scripts/check-design-rules.mjs): each rule finds its own case and leaves the ordinary alone, and the ratchet only lets a file go down.
import "../../../scripts/mac-test-guard.mjs";
import "./test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, problems, stale, RULES } from "./check-design-rules.mjs";

test("each rule finds its own case and leaves the ordinary alone", () => {
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

test("the ratchet: a file over its count is named, a file under it is stale, a file not listed starts at zero", () => {
  const found = { "screens/a.tsx": { "raw-colour": 2 }, "screens/b.tsx": { "style-sheet": 1 } };
  assert.deepEqual(problems(found, { "screens/a.tsx": { "raw-colour": 1 }, "screens/b.tsx": { "style-sheet": 1 } }), ["screens/a.tsx: raw-colour 2 (was 1)"]);
  assert.deepEqual(problems(found, {}), ["screens/a.tsx: raw-colour 2 (new)", "screens/b.tsx: style-sheet 1 (new)"]);
  assert.deepEqual(stale({ "screens/a.tsx": { "raw-colour": 1 } }, { "screens/a.tsx": { "raw-colour": 3 }, "screens/gone.tsx": { "style-sheet": 1 } }), ["screens/a.tsx: raw-colour 3 -> 1", "screens/gone.tsx: style-sheet 1 -> 0"]);
});
