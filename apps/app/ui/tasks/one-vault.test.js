// One Vault screen (A1): /u/vault is the Vault. The older phone-first list at /vault was a second screen with its own state, and "Open the Vault" on a stuck task still opened it.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = new URL("../../", import.meta.url);

test("a stuck task's Open the Vault link goes to the Vault, and no second Vault route exists", () => {
  const actions = fs.readFileSync(new URL("ui/tasks/TaskActions.tsx", app), "utf8");
  assert.ok(actions.includes('go("/u/vault")'), "the link opens /u/vault");
  assert.ok(!actions.includes('go("/vault")'), "not the older /vault");
  assert.equal(fs.existsSync(new URL("app/vault", app)), false, "no app/vault routes");
  assert.equal(fs.existsSync(new URL("src/vault/views.tsx", app)), false, "no second Vault list in src/vault");
  assert.equal(fs.existsSync(new URL("src/state/vault.ts", app)), false, "no second Vault state");
});
