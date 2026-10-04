import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hadIdentity, recoverIdentity, useIdentityStore } from "./restore.ts";
import { newCode } from "./recovery.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

test("recovery reads the identity from whichever store was handed over (the phone's, not the web store)", async () => {
  const seen = [];
  const phone = {
    hadIdentity: async () => { seen.push("had"); return true; },
    loadIdentity: async () => { seen.push("load"); return { name: "someone-else", id: "x", eid: "e", ops: [], pin: {}, kept: {}, software: false, createdAt: 0, key: {} }; },
    saveIdentity: async () => { seen.push("save"); },
    forgetIdentity: async () => { seen.push("forget"); },
  };
  useIdentityStore(phone);
  try {
    assert.equal(await hadIdentity(), true);
    // this phone already holds another name: refused from the phone store, before any directory call
    await assert.rejects(recoverIdentity({ name: "robin", code: newCode(), fetch: async () => { throw new Error("no network in this test"); } }), (e) => e.code === "exists");
    assert.deepEqual(seen, ["had", "load"]);
  } finally {
    const web = await import("./store.ts");
    useIdentityStore(web);
  }
});

test("the root layout hands the platform's store to recovery, and restore-wire imports ./store, not the web file", () => {
  assert.match(read("restore-wire.ts"), /import \* as store from "\.\/store";/);
  assert.match(read("restore-wire.ts"), /useIdentityStore\(store\)/);
  assert.match(read("../../app/_layout.tsx"), /import "\.\.\/src\/identity\/restore-wire";/);
  assert.doesNotMatch(read("restore-wire.ts"), /store\.ts"/);
});
