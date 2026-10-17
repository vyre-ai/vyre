import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mayReadHomeVault } from "./account-source.js";

test("only an account with no person, or a sign-in, may be read from the home's vault; a person's key must be kept in their own", () => {
  assert.equal(mayReadHomeVault({ person: null, kind: "api-key" }), true, "the home's own account");
  assert.equal(mayReadHomeVault({ person: "per_ben", kind: "login" }), true, "a sign-in carries no item");
  assert.equal(mayReadHomeVault({ person: "per_ben", kind: "api-key", own_vault: 1 }), true, "kept in Ben's own vault (the lend reads it there, never here)");
  assert.equal(mayReadHomeVault({ person: "per_ben", kind: "api-key", own_vault: 0 }), false, "a member's key not marked as kept in their vault would be the owner's item");
  assert.equal(mayReadHomeVault({ person: "per_ben", kind: "setup-token" }), false);
});
