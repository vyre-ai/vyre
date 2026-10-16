// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { TEST_KDF } from "../testing.js";
import { PeopleVaults } from "../people.js";
import { register } from "./browser-profile.js";
import { MEMBER_BROWSER_PROFILE_KEY } from "../../../lib/browser-profile.js";

const BOB = "per_" + "b".repeat(26);
const EVE = "per_" + "e".repeat(26);
const PW = "long-enough-master-password";

test("vault.person.browser-profile-key: computers module only; owner and member vaults", async t => {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-bprof-key-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const bobSk = (await people.create(BOB, { password: PW })).secretKey;
  const eveSk = (await people.create(EVE, { password: PW })).secretKey;
  await people.put(BOB, { name: MEMBER_BROWSER_PROFILE_KEY, kind: "secret", fields: { key: "0".repeat(64) } });
  await people.put(EVE, { name: MEMBER_BROWSER_PROFILE_KEY, kind: "secret", fields: { key: "f".repeat(64) } });
  /** @type {Record<string, Function>} */
  const tools = {};
  register({
    people,
    internal: (name, _d, _i, run) => { tools[name] = run; },
  });
  const run = tools["vault.person.browser-profile-key"];
  await assert.rejects(() => run({ person: BOB }, { caller: "module:glass" }), /computers module/);
  people.lock(BOB);
  await assert.rejects(() => run({ person: BOB }, { caller: "module:computers" }), /locked/);
  await people.unlock(BOB, { password: PW, secretKey: bobSk });
  const bob = await run({ person: BOB }, { caller: "module:computers" });
  assert.equal(bob.key, "0".repeat(64));
  await people.unlock(EVE, { password: PW, secretKey: eveSk });
  const eve = await run({ person: EVE }, { caller: "module:computers" });
  assert.equal(eve.key, "f".repeat(64));
});
