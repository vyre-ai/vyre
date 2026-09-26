// @ts-check
// `vyre capsule` runs a packaged app only when it was made from the source as it is now. The
// packaged app runs app.asar, so a stale one ignores every edit silently; this is the check that
// stops that happening again.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../../test/helpers.js";
import { sourceHash, packaged, electron } from "./capsule.js";
import { SCRATCH } from "../../../test/scratch.mjs";

function fakeCapsule(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-capsule-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "app"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "app", "main.js"), "// one");
  fs.writeFileSync(path.join(dir, "lib", "route.js"), "// two");
  return dir;
}

test("capsule: the source hash moves with the source, and not with its tests", t => {
  tempHome(t);
  const dir = fakeCapsule(t);
  const a = sourceHash(dir);
  fs.writeFileSync(path.join(dir, "lib", "route.test.js"), "// a test");
  assert.equal(sourceHash(dir), a, "tests are not part of the app");
  fs.writeFileSync(path.join(dir, "app", "main.js"), "// changed");
  assert.notEqual(sourceHash(dir), a);
});

test("capsule: a package is run only while its stamp matches the source", t => {
  tempHome(t);
  const dir = fakeCapsule(t);
  const app = path.join(dir, "dist", "Vyre-darwin-arm64", "Vyre.app");
  assert.deepEqual(packaged(dir, app), { bin: null, fresh: false });
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Vyre"), "");
  assert.equal(packaged(dir, app).fresh, false, "no stamp: not known to be fresh");
  fs.writeFileSync(path.join(path.dirname(app), "stamp.json"), JSON.stringify({ source: sourceHash(dir) }));
  assert.equal(packaged(dir, app).fresh, true);
  fs.writeFileSync(path.join(dir, "app", "main.js"), "// edited after packaging");
  assert.equal(packaged(dir, app).fresh, false, "an edit after packaging makes it stale");
});

test("capsule: Electron is looked for in the Capsule's own folder only", t => {
  tempHome(t);
  assert.equal(electron(fakeCapsule(t)), null);
});
