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
  assert.equal(isOwnerRefusal(null), false);
});

test("the owner's Mine uses the Space vault tools; a member's Mine stays on vault.me.*", () => {
  assert.equal(toolScope(true, "mine"), "space", "owner: Mine is the owner's vault");
  assert.equal(toolScope(true, "space"), "space");
  assert.equal(toolScope(false, "mine"), "mine", "member: Mine is her own vault");
  assert.equal(toolScope(false, "space"), "space");
});

test("the Mine connection-share panel: the owner's calls go to the Space vault's sharing, a member's to her own", async () => {
  const { connectionSharingFor } = await import("./owner-mine.js");
  const log = /** @type {string[]} */ ([]);
  const mk = (/** @type {string} */ n) => ({ load: async () => { log.push(`${n}.load`); return n; }, set: async () => { log.push(`${n}.set`); } });
  let owner = false;
  const p = connectionSharingFor(() => owner, () => mk("space"), mk("own"));
  assert.equal(await p.load({}), "own"); await p.set({}, {}, "use");
  owner = true;
  assert.equal(await p.load({}), "space"); await p.set({}, {}, "use");
  assert.deepEqual(log, ["own.load", "own.set", "space.load", "space.set"]);
});
