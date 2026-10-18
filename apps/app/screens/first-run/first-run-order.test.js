import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// A const used before its line throws "Cannot access 'x' before initialization" on the real first screen (it did: `path` read `shot` one line above `const shot`). The screen is a React component, so a source-order check
// is what runs without a renderer: every `const name = ...` of the first function body that another earlier line reads is reported.
test("FirstRunScreens reads no constant before the line that makes it", () => {
  const src = fs.readFileSync(new URL("./FirstRun.tsx", import.meta.url), "utf8");
  const start = src.indexOf("function FirstRunScreens");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n  if (screen ===", start)).split("\n");
  const declared = new Map();
  body.forEach((l, i) => { const m = /^  const (\w+) = /.exec(l); if (m && !declared.has(m[1])) declared.set(m[1], i); });
  const bad = [];
  body.forEach((l, i) => {
    for (const [name, at] of declared) if (at > i && new RegExp(`(?<![\\w.])${name}(?![\\w]|\\?:)`).test(l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/.*$/, "")) && !new RegExp(`^  const ${name} = `).test(l)) bad.push(`${name} is read on line ${i + 1} of the body, before its line ${at + 1}`);
  });
  assert.deepEqual(bad, []);
});
