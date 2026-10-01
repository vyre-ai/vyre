import { test } from "node:test";
import assert from "node:assert/strict";
import { changes } from "../scripts/lock-changes.mjs";

const lock = pk => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "app" }, ...pk } });
test("lock-changes: added, removed, version-changed and same-version-different-integrity packages are listed, sorted", () => {
  const a = lock({ "node_modules/left": { version: "1.0.0", integrity: "sha512-a" }, "node_modules/gone": { version: "2.0.0", integrity: "sha512-b" }, "node_modules/same": { version: "3.0.0", integrity: "sha512-c", resolved: "https://r/same-3.tgz" }, "node_modules/@s/pkg": { version: "1.0.0", integrity: "sha512-d" } });
  const b = lock({ "node_modules/left": { version: "1.1.0", integrity: "sha512-a2" }, "node_modules/new": { version: "0.1.0", integrity: "sha512-n" }, "node_modules/same": { version: "3.0.0", integrity: "sha512-X", resolved: "https://r/same-3.tgz" }, "node_modules/@s/pkg": { version: "1.0.0", integrity: "sha512-d" } });
  assert.deepEqual(changes(a, b), ["- gone@2.0.0", "~ left 1.0.0 -> 1.1.0", "+ new@0.1.0", "~ same@3.0.0: same version, different integrity"]);
  assert.deepEqual(changes(a, a), []);
  assert.deepEqual(changes("", b).filter(l => l.startsWith("+")).length, 4, "no previous lock: everything is added");
});
