import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const metro = fs.readFileSync(path.join(app, "metro.config.js"), "utf8");
// The pattern Metro blocks in a real build (every build but EXPO_PUBLIC_VYRE_MOCK=1): the sample-world pages are not registered as routes.
const m = /blockList[^\n]*\[(\/.*\/)\]\);/.exec(metro);

test("the real build blocks the sample-world pages from Metro, the mock build does not", () => {
  assert.ok(m, "metro.config.js blocks the sample-world pages");
  assert.match(metro, /if \(process\.env\.EXPO_PUBLIC_VYRE_MOCK !== "1"\) \{\n\s+config\.resolver\.blockList/, "only a build that is not the mock build blocks them");
});

test("the Flow shot page is among the blocked routes, and so is every shots-* page", () => {
  const re = new RegExp(m[1].slice(1, -1));
  const files = ["app/u/flows/shot.tsx", ...fs.readdirSync(path.join(app, "app")).filter((f) => /^shots-/.test(f)).map((f) => `app/${f}`)];
  for (const f of files) assert.ok(re.test(path.join(app, f)), `${f} is not registered in a real build`);
  assert.ok(fs.existsSync(path.join(app, "app/u/flows/shot.tsx")), "the shot page exists");
  assert.equal(re.test(path.join(app, "app/u/flows/new.tsx")), false, "a real flows page is not blocked");
  assert.equal(re.test(path.join(app, "app/u/flows/[id].tsx")), false);
});
