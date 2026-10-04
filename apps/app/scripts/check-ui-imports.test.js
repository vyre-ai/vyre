import "../../../scripts/mac-test-guard.mjs";
import "./test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { offenders } from "./check-ui-imports.mjs";

test("the app has no UI library import outside @vyre/ui", () => {
  assert.deepEqual(offenders(), []);
});

test("the check finds one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiimp-"));
  fs.mkdirSync(path.join(dir, "app"));
  fs.writeFileSync(path.join(dir, "app", "x.tsx"), `import { flexRender } from "@tanstack/react-table";\nimport { Text } from "@vyre/ui";\n`);
  assert.deepEqual(offenders(dir), [{ file: path.join("app", "x.tsx"), spec: "@tanstack/react-table" }]);
  fs.rmSync(dir, { recursive: true });
});
