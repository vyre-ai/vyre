// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { documentRow } from "./record.js";

const SPACE = "spc_abcdefghijkl", UUID = "01a12326-6b9a-43f8-b32b-443ebbfbd155";
const KIT = [{ name: "name", kind: "text" }, { name: "status", kind: "choice", options: ["Waiting", "Signed", "Declined"] }, { name: "template", kind: "text" }, { name: "file", kind: "text" },
  { name: "contact", kind: "link" }, { name: "project", kind: "link" }];
const o = (/** @type {Record<string, string | null>} */ projects = {}) => ({ space: SPACE, project: async (/** @type {string} */ ref) => projects[ref] ?? null });

test("a document becomes a row of the Space's own Document type: links hold { urn }, a choice takes only its options, unknown fields are dropped", async () => {
  const contact = `vyre://${SPACE}/contact/${UUID}`, project = `vyre://${SPACE}/project/${UUID.replace("01a", "02b")}`;
  const row = await documentRow(KIT, { name: "Letter", status: "Draft", template: "Engagement", template_version: 2, sha256: "abc", source: "generated", file: "Documents/x.docx", contact, project: "harlow-estate" }, o({ "harlow-estate": project }));
  assert.deepEqual(row, { name: "Letter", template: "Engagement", file: "Documents/x.docx", contact: { urn: contact }, project: { urn: project } });
  // a status the type has is kept; a project given as its urn is kept as it is
  assert.equal((await documentRow(KIT, { name: "L", status: "Waiting", project }, o())).status, "Waiting");
  assert.deepEqual((await documentRow(KIT, { name: "L", project }, o())).project, { urn: project });
});

test("a link that does not name a record of this Space, or a project nobody knows, is left off rather than failing the filing", async () => {
  const row = await documentRow(KIT, { name: "L", contact: "dana@harlow.test", project: "no-such-project" }, o());
  assert.deepEqual(row, { name: "L" });
  const other = await documentRow(KIT, { name: "L", contact: `vyre://spc_zzzzzzzzzzzz/contact/${UUID}` }, o());
  assert.equal(other.contact, undefined, "another Space's record is not linked");
  const many = await documentRow([{ name: "contact", kind: "link", many: true }], { contact: `vyre://${SPACE}/contact/${UUID}` }, o());
  assert.deepEqual(many.contact, [{ urn: `vyre://${SPACE}/contact/${UUID}` }]);
});
