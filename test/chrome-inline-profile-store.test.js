// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { deriveProfileKey, sealProfile, openProfile, createProfileStore } from "../core/computers/profile-store.js";

test("profile-store: vault material seals and opens a profile blob per agent id", () => {
  const key = deriveProfileKey("vault-secret-material", "agt_test123", "agent-browser-profile");
  const plain = Buffer.from("cookies-and-storage");
  const packed = sealProfile(key, plain);
  assert.deepEqual(openProfile(key, packed), plain);
});

test("profile-store: agent vs member keys differ", async () => {
  const store = createProfileStore({
    fetchAgent: async () => "space-root",
    fetchMember: async () => "personal-root",
  });
  const a = await store.keyFor("agt_a", "agent");
  const m = await store.keyFor("agt_a", "member");
  assert.ok(a && m);
  assert.notDeepEqual(a, m);
});
