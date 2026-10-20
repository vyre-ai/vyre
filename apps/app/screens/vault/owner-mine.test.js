// The owner's Mine tab shows the owner's vault (vault.*); a member keeps vault.me.*. The refusal text is the server's own (core/vault/tools/me.js), so the two cannot drift apart.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isOwnerRefusal, toolScope } from "./owner-mine.js";
import { ME_REFUSAL } from "../../../../core/vault/tools/me.js";

test("the server's refusal of the owner is recognised, and nothing else is", () => {
  assert.equal(isOwnerRefusal(Object.assign(new Error(ME_REFUSAL), { code: "denied" })), true, "the owner's refusal");
  assert.equal(isOwnerRefusal(Object.assign(new Error("locked"), { code: "locked" })), false, "a locked vault is not it");
  assert.equal(isOwnerRefusal(Object.assign(new Error("not allowed"), { code: "denied" })), false, "another denial is not it");
  assert.equal(isOwnerRefusal(Object.assign(new Error("vault.me.account.status isn't on this Mac yet: vyre-core holds the vault here, and this part hasn't moved into it"), { code: "core_owned" })), true, "a Mac server's answer: no member vault there, so Mine is the vault it has");
  assert.equal(isOwnerRefusal(null), false);
});

test("the owner's Mine uses the Space vault tools; a member's Mine stays on vault.me.*", () => {
  assert.equal(toolScope(true, "mine"), "space", "owner: Mine is the owner's vault");
  assert.equal(toolScope(true, "space"), "space");
  assert.equal(toolScope(false, "mine"), "mine", "member: Mine is her own vault");
  assert.equal(toolScope(false, "space"), "space");
});

test("the owner's Mine and Shared show different stores: items in no folder, and items in a Space folder or shared from elsewhere", async () => {
  const { splitOwner, storeOf } = await import("./owner-mine.js");
  const rows = [{ name: "GHL-Sales" }, { name: "Twilio", folder: "vault_team" }, { name: "partner/Stripe" }, { name: "Airline-account" }];
  const { mine, shared } = splitOwner(rows);
  assert.deepEqual(mine.map((r) => r.name), ["GHL-Sales", "Airline-account"]);
  assert.deepEqual(shared.map((r) => r.name), ["Twilio", "partner/Stripe"]);
  assert.equal(mine.filter((r) => shared.includes(r)).length, 0, "no item is in both");
  assert.notEqual(storeOf(true, "mine"), storeOf(true, "shared"), "the switch changes what the owner reads");
  assert.notEqual(storeOf(false, "mine"), storeOf(false, "shared"));
});
