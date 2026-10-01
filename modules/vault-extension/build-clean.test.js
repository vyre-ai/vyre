// @ts-check
// The shipped extension carries no test seam. The real-Chrome runs (testing/browser-check.mjs, chip-check.mjs) drive the extension from
// OUTSIDE, through DevTools into the worker's own functions, and add nothing to the product: the build is a plain copy of the source
// files and a manifest transform. This test builds the way a release does and proves it: every packaged file is byte-identical to its
// source, no file the testing folder owns is in the package, and no test-only name or override appears in any packaged file.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, packageFiles } from "./build.mjs";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/** Names and overrides that exist only in tests. Not one may appear in a packaged file. */
const TEST_ONLY = [/__vyreTest/, /vyreKeyChipMinMs/, /test-pair/, /testPair/, /browser-check/, /chip-check/, /permissions\.contains\s*=/, /unlockPass/, /VYRE_TEST/, /CHROME_EXTRA_FLAGS/];

test("the release build is a plain copy: byte-identical files, nothing from testing/, no test-only name or override", t => {
  const out = fs.mkdtempSync(path.join(SCRATCH, "vyre-extbuild-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const dirs = build(out);
  const source = packageFiles(HERE);
  assert.ok(!source.some(f => /testing|\.test\./.test(f)), "the package list never includes tests");
  for (const target of /** @type {const} */ (["chrome", "firefox"])) {
    const got = fs.readdirSync(dirs[target]).sort();
    assert.deepEqual(got, source, `${target}: exactly the packaged source files, nothing added`);
    for (const f of got) {
      if (f === "manifest.json") continue;
      assert.equal(sha(path.join(dirs[target], f)), sha(path.join(HERE, f)), `${target}/${f} is byte-identical to its source`);
      const text = fs.readFileSync(path.join(dirs[target], f), "utf8");
      for (const re of TEST_ONLY) assert.ok(!re.test(text), `${target}/${f} carries ${re}`);
    }
  }
  assert.ok(!fs.existsSync(path.join(out, "chrome", "testing")), "no testing folder in the package");
});

test("the keychip's test hook cannot be set from a page: it reads only the content script's own isolated global", () => {
  const src = fs.readFileSync(path.join(HERE, "keychip.js"), "utf8");
  // The only knob is the minimum visible time, read from the script's own global (a page's globals are a different world). The
  // browser run proves the real value (400 ms) applies when unset; this pins that nothing else is read from it.
  assert.equal((src.match(/g\.vyre[A-Za-z]*/g) || []).filter(x => x !== "g.vyreKeyChip" && x !== "g.vyreKeyFind").length, 0, "no other g.vyre* knob");
});
