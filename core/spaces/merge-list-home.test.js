// @ts-check
// spaces.merge-list lists the home's own Space only for Publish, and only for a member of it. Another module that asks with `home` gets the list without it (the flag is ignored), a non-member gets none from Publish
// either, and without the flag nobody gets the home. Real daemon, kernel on: the owner is the home's one member.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const STRANGER = "per_zzzzzzzzzzzzzzzzzzzzzzzzzz";

test("the home Space is listed for Publish's member alone: the flag from any other module is ignored, a non-member gets none, and without the flag the home stays out", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, HOME = d.kernel.id.space;
  const ids = async (/** @type {string} */ caller, /** @type {any} */ input) => { const r = await d.registry.call("spaces.merge-list", input, caller); assert.ok(!r.error, `${caller}: ${JSON.stringify(r.error)}`); return (r.data.spaces || []).map((/** @type {any} */ s) => s.space); };
  assert.deepEqual(await ids("module:publish", { person: OWNER, home: true }), [HOME], "Publish: the owner, a member of the home, gets it");
  assert.deepEqual(await ids("module:publish", { person: STRANGER, home: true }), [], "Publish: a non-member gets none");
  assert.deepEqual(await ids("module:publish", { person: OWNER }), [], "Publish without the flag: the home stays out");
  for (const other of ["module:bridges", "module:records-tools", "module:mail"]) assert.deepEqual(await ids(other, { person: OWNER, home: true }), [], `${other}: the flag is ignored, so the home stays out`);
});
