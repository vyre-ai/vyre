// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { linkFieldFrom, linkValue } from "./link-fields.js";

const defs = [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text" }] }, { name: "deal", label: "Deal", fields: [{ name: "name", kind: "text" }, { name: "company", kind: "link", to: "organization" }] }, { name: "organization", label: "Organization", fields: [] }];

test("a link field is named from its label, goes to a type that exists, and may name its other end", () => {
  assert.deepEqual(linkFieldFrom({ label: "Referred by", to: "contact" }, defs[1], defs), { name: "referred_by", kind: "link", label: "Referred by", to: "contact" });
  assert.deepEqual(linkFieldFrom({ label: "Contacts", to: "contact", many: true, inverse_label: "Deals involved in" }, defs[1], defs).inverse, { name: "deals_involved_in", label: "Deals involved in" });
  assert.equal(linkFieldFrom({ label: "Buyer", to: "contact", many: true, required: true }, defs[1], defs).required, true);
  assert.throws(() => linkFieldFrom({ label: "Company", to: "organization" }, defs[1], defs), /already has a field called company/);
  assert.throws(() => linkFieldFrom({ label: "Buyer", to: "nothing" }, defs[1], defs), /no record type called nothing/);
  assert.throws(() => linkFieldFrom({ label: "Name", to: "contact" }, defs[1], defs), /cannot be a field name/);
  assert.throws(() => linkFieldFrom({ label: "!!!", to: "contact" }, defs[1], defs), /cannot be a field name/);
  assert.throws(() => linkFieldFrom({ label: "Buyer", to: "contact", inverse_label: "  " }, defs[1], defs), /cannot name the other end/);
});

test("a link value is one record, or a list for a list field; none clears it", () => {
  const one = { name: "company", label: "Company", kind: "link" }, many = { ...one, many: true };
  assert.deepEqual(linkValue(one, "vyre://s/organization/1"), { urn: "vyre://s/organization/1" });
  assert.deepEqual(linkValue(many, ["vyre://s/organization/1", "vyre://s/organization/2"]), [{ urn: "vyre://s/organization/1" }, { urn: "vyre://s/organization/2" }]);
  assert.deepEqual(linkValue(many, "vyre://s/organization/1"), [{ urn: "vyre://s/organization/1" }]);
  assert.equal(linkValue(one, null), null);
  assert.deepEqual(linkValue(many, []), []);
  assert.throws(() => linkValue(one, ["a", "b"]), /holds one record/);
});
