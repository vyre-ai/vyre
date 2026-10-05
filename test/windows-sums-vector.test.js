// @ts-check
// The Windows app's Rust updater and vyre-core's verifySums must agree on the same signed
// SHA256SUMS bytes: this pins the fixture the Rust tests read.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifySums, RELEASE_KEY } from "../core/vyre-core/release.js";

const v = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/sums-vector.json", import.meta.url), "utf8"));

test("windows sums vector: verifySums accepts it and refuses a changed byte", () => {
  const m = verifySums(v.sums, v.sig, { key: v.key });
  assert.equal(m.get("Vyre_0.2.0_x64-setup.exe"), "aa".repeat(32));
  assert.throws(() => verifySums(v.sums.replace("aa", "ab"), v.sig, { key: v.key }), /does not verify/);
});

test("windows updater pins the same release key as vyre-core", () => {
  const rs = fs.readFileSync(new URL("../local/capsule/native-win/src/update.rs", import.meta.url), "utf8");
  assert.ok(rs.includes(`"${RELEASE_KEY}"`), "update.rs RELEASE_KEY matches release.js");
});

test("windows updater's shared vector is launch's, verified by verifySums too", () => {
  const key = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
  const sums = "a".repeat(64) + "  manifest.json\n" + "b".repeat(64) + "  vyre.tgz\n";
  const sig = "X+aWDX+6p5YDh32E4tUXAHKEvCwi36rUm4I889QLs2I6b4hlP0J05o8PNtuyZnsCaqMkiv2MWmqJ3fllTLIzDA==";
  assert.equal(verifySums(sums, sig, { key }).get("vyre.tgz"), "b".repeat(64));
  const rs = fs.readFileSync(new URL("../local/capsule/native-win/src/update.rs", import.meta.url), "utf8");
  assert.ok(rs.includes(key) && rs.includes(sig), "update.rs carries the same shared vector");
});

test("windows pairing page: every relay-client name it imports exists there", async () => {
  // Every page script in the folder (pair.js and seed.js became first-run-pair.js, typed-pair.js, link.js and the rest).
  const dir = new URL("../local/capsule/native-win/app/ui/", import.meta.url);
  const pages = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.ok(pages.length > 0, "the pairing page scripts exist");
  for (const file of pages) {
    const src = fs.readFileSync(new URL(file, dir), "utf8");
    for (const m of src.matchAll(/import \{([^}]+)\} from "\.\/(relay|vendor)\/([\w-]+)\.js"/g)) {
      const at = m[2] === "relay" ? `../relay/client/${m[3]}.js` : `../web/vendor/${m[3]}.js`;
      const mod = await import(new URL(at, import.meta.url).href);
      for (const name of m[1].split(",").map((s) => s.trim()).filter(Boolean)) assert.ok(name in mod, `${at} exports ${name}`);
    }
  }
});

import { compare } from "../lib/releases.js";
test("windows updater: the semver order is lib/releases.js's, case for case", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../local/capsule/native-win/tests/semver-cases.json", import.meta.url), "utf8"));
  for (const [a, b, want] of cases) assert.equal(compare(a, b), want, `${a} vs ${b}`);
});
