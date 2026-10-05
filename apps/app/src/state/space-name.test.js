import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spaceName } from "./space-name.js";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("the one naming function: Personal, My Cloud, a team's own name, never an id, Basic or Pro", () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(spaceName({ id: "s", name: "alex.vyre.run", tier: "basic", setup: { who: "personal" } }), "Personal");
    assert.equal(spaceName({ id: "s", name: "alex.vyre.run", tier: "cloud", setup: { who: "personal" } }), "My Cloud");
    assert.equal(spaceName({ id: "s", name: "harlow.vyre.run", tier: "cloud" }), "harlow");
    assert.equal(spaceName({ id: "s", displayName: "Harlow Legal", tier: "cloud" }), "Harlow Legal");
    assert.equal(spaceName({ id: "spc_1", name: "spc_1", tier: "cloud" }), "Space");
    assert.equal(spaceName({ id: "s", name: "alex.vyre.run", tier: "pro", setup: { who: "personal" } }), "alex", "pro is not a value any more: it is read as a name, not a tier");
  } finally { console.warn = warn; }
});

test("no screen builds a space's name from the row's fields by itself: every one calls spaceName", () => {
  const bad = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".expo"].includes(e.name) || e.name.startsWith("dist")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const rel = path.relative(APP, p);
      if (rel === "src/state/space-name.js" || rel.startsWith("src/identity/")) continue;
      for (const line of fs.readFileSync(p, "utf8").split("\n")) if (/space/i.test(line) && /(?:displayName|\.label)\s*\|\|\s*\w+\.(?:label|name)\b/.test(line)) { bad.push(rel); break; }
    }
  };
  walk(path.join(APP, "screens")); walk(path.join(APP, "src")); walk(path.join(APP, "ui"));
  assert.deepEqual(bad, [], "these build a space name by hand");
});
