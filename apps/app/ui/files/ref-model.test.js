import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { refIcon, refRoute } from "./ref-model.js";

test("a reference opens the page of what it names", () => {
  assert.equal(refRoute("vyre://acme/agent/juno"), "/u/assistants/juno");
  assert.equal(refRoute("vyre://acme/project/p_7"), "/u/project/p_7");
  assert.equal(refRoute("vyre://acme/tag/estate%20plan"), "/u/tags/estate%20plan");
  assert.equal(refRoute("vyre://acme/matter/m_9"), "/u/records/matter");
  assert.equal(refRoute("vyre://acme/type/client"), "/u/records/client");
  assert.equal(refRoute("vyre://acme/file/Clients/a.pdf"), "/u/files");
  assert.equal(refRoute("vyre://acme/person/p_1"), "/u/settings/roles");
  assert.equal(refRoute("not an address"), "/u/now");
});

test("each kind has its own icon", () => {
  assert.deepEqual(["person", "agent", "record", "project", "file", "tag"].map((k) => refIcon("@", k)), ["person", "agents", "records", "projects", "file", "hash"]);
});
