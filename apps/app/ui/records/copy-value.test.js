// A property row copies an email, a phone, a URL or an id-like value, and nothing else.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { copyValue, recordPath } from "./copy-value.js";

test("email, phone, URL and id-like values copy; names, notes and sealed values do not", () => {
  assert.equal(copyValue({ name: "email", label: "Email", kind: "text" }, "ada@example.com"), "ada@example.com");
  assert.equal(copyValue({ name: "other_emails", label: "Emails", kind: "emails" }, ["a@b.co", "c@d.co"]), "a@b.co, c@d.co");
  assert.equal(copyValue({ name: "phone", label: "Phone", kind: "text" }, " 555 0100 "), "555 0100");
  assert.equal(copyValue({ name: "mobile", label: "Mobile", kind: "phones" }, "555"), "555");
  assert.equal(copyValue({ name: "website", label: "Website", kind: "url" }, "https://example.com"), "https://example.com");
  assert.equal(copyValue({ name: "website", label: "Website", kind: "text" }, "https://example.com"), "https://example.com");
  assert.equal(copyValue({ name: "ref", label: "ID", kind: "text" }, "PER-0001"), "PER-0001");
  assert.equal(copyValue({ name: "code", label: "Code", kind: "text" }, "PER-0001"), "PER-0001");
  assert.equal(copyValue({ name: "name", label: "Name", kind: "text" }, "Jane Doe"), "");
  assert.equal(copyValue({ name: "notes", label: "Notes", kind: "text" }, "A long note about the work"), "");
  assert.equal(copyValue({ name: "email", label: "Email", kind: "text" }, "  "), "");
  assert.equal(copyValue({ name: "secret", label: "Secret", kind: "sealed" }, { sealed: "x" }), "");
  assert.equal(copyValue({ name: "template", label: "Template", kind: "text" }, "tpl_ad-campaign"), "");
  assert.equal(copyValue({ name: "budget", label: "Budget", kind: "money" }, { amount: 10 }), "");
  assert.equal(copyValue({ name: "company", label: "Company", kind: "link" }, "Acme"), "");
  assert.equal(copyValue(null, "PER-0001"), "");
});

test("the record path encodes the id", () => {
  assert.equal(recordPath("a/b"), "/u/record/a%2Fb");
  assert.equal(recordPath(""), "/u/record/");
});
