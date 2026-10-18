import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { expectedRequest, promptFor } from "./kernel-wire.js";
import { proofRequest } from "../../../../kernel/remote/proof.js";

const SPACE = "spc_aaaaaaaaaaaa";

test("the app works out the SAME request the home does for a member's key: op, fields and hash, from the label and the key's hash only", () => {
  const args = [{ label: "Work Claude", value: "sk-ant-0123456789abcdef", password: "a password", secret_key: "SK" }];
  const mine = expectedRequest(SPACE, "myvault.addkey", args);
  const theirs = proofRequest(SPACE, "vaultAddKey", args[0]);
  assert.deepEqual([mine.op, mine.fields, mine.payload_hash], [theirs.op, theirs.fields, theirs.payload_hash]);
  assert.equal(mine.op, "grant.add_key");
  assert.ok(!JSON.stringify(mine).includes("sk-ant-") && !JSON.stringify(mine).includes("a password"));
  assert.notEqual(mine.payload_hash, expectedRequest(SPACE, "myvault.addkey", [{ ...args[0], value: "sk-ant-other-0123456789" }]).payload_hash);
  assert.equal(expectedRequest(SPACE, "myvault.status", [{}]), null, "a call this app does not sign has no request");
});

test("the person is told which key they are approving: its label, which is in the signed request", () => {
  assert.equal(promptFor("myvault.addkey", [{ label: "Work Claude", value: "sk-ant-0123456789abcdef" }]), "Add Work Claude to your own Vault");
  assert.ok(!promptFor("myvault.addkey", [{ label: "Work Claude", value: "sk-ant-0123456789abcdef" }]).includes("sk-ant-"));
  assert.equal(promptFor("grants.invites.create", [{}]), "Invite someone to your team");
  assert.equal(promptFor("grants.unknown", []), "Approve this change");
});
