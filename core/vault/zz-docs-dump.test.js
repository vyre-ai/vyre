// TEMPORARY: prints the generated reference pages so they can be committed without running node locally. Removed right after.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { REPO, generateAll } from "../../scripts/lib/docs/reference.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("zz docs dump", () => {
  const pages = generateAll({ root: REPO, tmp: SCRATCH });
  for (const name of ["reference/tools.md", "reference/index.md", "index.json", "reference/modules.md", "reference/events.md"]) {
    const b = zlib.gzipSync(Buffer.from(pages[name], "utf8")).toString("base64");
    for (let i = 0; i * 3000 < b.length; i++) console.log(`DOCDUMP|${name}|${i}|${b.slice(i * 3000, (i + 1) * 3000)}`);
    console.log(`DOCDUMP|${name}|END|${b.length}`);
  }
  assert.fail("dump");
});
