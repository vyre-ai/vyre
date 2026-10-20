import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The callers that put the chat key's point on a device entry still read agreePublic: claim.js and restore.ts write it, so the point on the list is the record's key (src/crypto/agree-key.ts).
test("a browser's claim and recovery put that point on the entry as agree (the callers read agreePublic, claim.js and restore.ts write it)", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const install = read("../real/install.ts");
  assert.match(install, /const agreeKey = \(await agreePublic\(true\)\) \?\? undefined;/);
  assert.match(install, /\.\.\.\(agreeKey \? \{ agree: agreeKey \} : \{\}\)/, "claim gets it, with or without a Mac");
  assert.match(read("./claim.js"), /\.\.\.\(o\.agree \? \{ agree: o\.agree \} : \{\}\)/);
  const keys = read("../keys/index.ts");
  assert.match(keys, /if \(!macKeyAvailable\(\)\) \{ const agree = \(await agreePublic\(true\)\)/, "recovery in a browser carries it too");
});
