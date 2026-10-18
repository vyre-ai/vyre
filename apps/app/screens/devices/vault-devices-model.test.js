import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { groupDevices, extensions, provisioned, cleanCode } from "./vault-devices-model.js";

test("the vault group's devices: name, role in plain words, fingerprint", () => {
  const rows = groupDevices({ devices: [{ id: "d1", name: "Alex's Mac", role: "full", fingerprint: "AB12" }, { id: "d2", name: "Home server", role: "storage" }, { nope: 1 }] });
  assert.deepEqual(rows.map((r) => [r.name, r.line]), [["Alex's Mac", "Full, fingerprint AB12"], ["Home server", "Storage"]]);
  assert.deepEqual(groupDevices(null), []);
});

test("autofill extensions say locked, unlocked or revoked, and when they were last seen", () => {
  const now = Date.UTC(2026, 9, 18);
  const rows = extensions({ devices: [{ id: "x1", name: "Chrome", sessions: 1, lastSeen: now }, { id: "x2", name: "Edge", revoked: true, lastSeen: now - 3 * 86_400_000 }, { id: "x3" }] }, now);
  assert.deepEqual(rows.map((r) => [r.id, r.revoked, r.line]), [["x1", false, "Unlocked, seen today"], ["x2", true, "Revoked, seen 3 days ago"], ["x3", false, "Locked"]]);
  assert.deepEqual(extensions({}), []);
});

test("provisioned accounts are the apps a member acts as, and a code is pasted whole", () => {
  assert.deepEqual(provisioned({ accounts: [{ app: "Google", account: "dana@example.test" }, { account: "x" }] }), [{ id: "Google:dana@example.test", title: "Google", line: "Acts as dana@example.test" }]);
  assert.equal(cleanCode("  abc\n def  "), "abcdef");
});
