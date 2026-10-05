import "../../../scripts/mac-test-guard.mjs";
import "./test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { appVersion } = require("./app-version.cjs");

test("a release version gives an iOS short version, an Android name and a rising code", () => {
  assert.deepEqual(appVersion("0.2.9"), { name: "0.2.9", short: "0.2.9", code: 20990 + 0 });
  assert.ok(appVersion("0.2.10").code > appVersion("0.2.9").code);
  assert.ok(appVersion("0.3.0").code > appVersion("0.2.99").code);
});
test("a release candidate has a dotted iOS version and a code below its release and above the one before", () => {
  const rc = appVersion("0.3.0-rc.1");
  assert.equal(rc.short, "0.3.0");
  assert.equal(rc.name, "0.3.0-rc.1");
  assert.ok(rc.code < appVersion("0.3.0").code);
  assert.ok(rc.code > appVersion("0.2.9").code);
  assert.ok(appVersion("0.3.0-rc.2").code > rc.code);
});
test("a version that is not a release version is refused", () => {
  for (const v of ["", "0.3", "v0.3.0", "0.3.0-"]) assert.throws(() => appVersion(v));
});
test("app.config.js takes the version from the repo's package.json, so the release bump reaches the app", () => {
  // apps/app is an ES module package, so Node would not load the CommonJS config as a file; run it the way Expo does, with a module and a require of its own.
  const src = readFileSync(new URL("../app.config.js", import.meta.url), "utf8");
  const mod = { exports: {} };
  const here = createRequire(new URL("../app.config.js", import.meta.url));
  new Function("module", "require", src)(mod, here);
  const cfg = mod.exports({ config: { version: "0.0.0", ios: {}, android: {} } });
  const want = appVersion(JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version);
  assert.equal(cfg.version, want.short);
  assert.equal(cfg.android.versionCode, want.code);
  assert.equal(cfg.ios.buildNumber, String(want.code));
});
