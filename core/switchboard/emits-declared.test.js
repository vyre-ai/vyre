import "../../scripts/mac-test-guard.mjs";
// Every event the Switchboard emits by name is declared in its manifest (watches.emits): the kernel refuses an undeclared one at the emit, which ended a session start on the packaged box
// ("threads emitted thread.sandbox, which its manifest does not declare").
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("the Switchboard's manifest declares every event it emits by a literal name", () => {
  const src = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const declared = new Set(JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).watches.emits);
  const used = new Set([...src.matchAll(/\bthis\.emit\(\s*"([a-z]+\.[a-z.]+)"/g)].map(m => m[1]));
  assert.ok(used.size > 5, "found the emits");
  const missing = [...used].filter(n => !declared.has(n));
  assert.deepEqual(missing, []);
});
