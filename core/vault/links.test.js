// @ts-check
// The words and the address check of a credential linked to a record (R031-71). The link itself is the record's own `credentials` field, tested on a real daemon in test/vault-links-timeline.test.js.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { byWords, LINKED_URN } from "./links.js";
import { credentialUrn } from "../../kernel/contracts/index.js";

test("who used it is said in words, never as an id", () => {
  assert.equal(byWords("mcp agent:kit"), "the agent kit");
  assert.equal(byWords("module:appmods"), "Vyre's appmods module");
  assert.equal(byWords("device:abcdefghijklmnop:laptop chrome"), "one of your devices");
  assert.equal(byWords("mcp"), "an assistant");
  assert.equal(byWords("cli"), "you");
});

test("a record address is a record's; a credential's address is the one spelling", () => {
  assert.equal(LINKED_URN.test("vyre://spc_aaaaaaaaaaaa/client/0194c2a1-7b3e-4c1d-9a55-3f2b8e6d7c10"), true);
  for (const bad of ["", "client/1", "https://example.test/x", "vyre://spc_a/client", "vyre://spc_a/client/../../etc"]) assert.equal(LINKED_URN.test(bad), false, bad);
  assert.equal(credentialUrn("spc_aaaaaaaaaaaa", "vault://portal-login"), "vyre://spc_aaaaaaaaaaaa/credential/portal-login");
  assert.equal(credentialUrn("spc_aaaaaaaaaaaa", "portal-login"), credentialUrn("spc_aaaaaaaaaaaa", "vault://portal-login"));
});
