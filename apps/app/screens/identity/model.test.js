import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { SAY, createCall, migrateCall, pairOk, recoveryCall, unlockCall } from "./model.js";

test("create, unlock and migrate call the identity tools, and a recovery key waits for a confirmation", () => {
  const made = createCall({ username: " Alex ", password: "correct horse battery", confirm: "correct horse battery" });
  assert.equal(made.tool, "identity.create");
  assert.deepEqual(made.input, { username: "alex", password: "correct horse battery" });
  assert.equal(createCall({ username: "ab", password: "correct horse battery", confirm: "correct horse battery" }).error, "name");
  assert.equal(createCall({ username: "alex", password: "short", confirm: "short" }).error, "short");
  assert.equal(createCall({ username: "alex", password: "correct horse battery", confirm: "other horse battery" }).error, "differ");
  assert.equal(unlockCall({ password: "correct horse battery" }).tool, "identity.unlock");
  assert.equal(unlockCall({ password: "correct horse battery" }).input.recovery, undefined);
  assert.equal(migrateCall({ password: "correct horse battery", confirm: "correct horse battery" }).tool, "identity.migrate");
  const pending = recoveryCall({ recovery: "aaaa-bbbb" });
  assert.equal(pending.tool, "identity.unlock");
  assert.equal(pending.step, "confirm");
  assert.equal(pending.input.confirm, undefined);
  const yes = recoveryCall({ recovery: "aaaa-bbbb", confirmed: true });
  assert.equal(yes.step, "done");
  assert.equal(yes.input.confirm, true);
  assert.equal(yes.input.password, undefined);
  assert.equal(recoveryCall({ recovery: "  " }).error, "empty");
  assert.equal(pairOk("correct horse battery", "correct horse battery"), "ok");
  for (const line of Object.values(SAY)) assert.equal(line.includes("\u00a7"), false);
});
