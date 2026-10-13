// The pure half of the record page's Documents bar: which records fill a template, which waiting requests are this person's, what a template asks for that this record cannot give.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { aliasesFor, waitingFor, unfilled, whenWords } from "./documents-model.js";

test("a template can name the record by its type, as record, and each related type by its own name (the first of each)", () => {
  const a = aliasesFor({ name: "contact" }, { urn: "vyre://s/contact/1" }, [{ urn: "vyre://s/project/9", type: "project" }, { urn: "vyre://s/project/10", type: "project" }, { urn: "vyre://s/asset/3", type: "asset" }]);
  assert.deepEqual(a, { contact: "vyre://s/contact/1", record: "vyre://s/contact/1", project: "vyre://s/project/9", asset: "vyre://s/asset/3" });
});

test("a related record never replaces the record itself under the same name", () => {
  const a = aliasesFor({ name: "contact" }, { urn: "vyre://s/contact/1" }, [{ urn: "vyre://s/contact/2", type: "contact" }]);
  assert.equal(a.contact, "vyre://s/contact/1");
});

test("waiting requests are the ones for this person's address, any case", () => {
  const reqs = [{ submission: 1, email: "Jane@Example.org", template: "Engagement" }, { submission: 2, email: "bob@x.org" }];
  assert.deepEqual(waitingFor(reqs, "jane@example.org").map((r) => r.submission), [1]);
  assert.deepEqual(waitingFor(reqs, ""), []);
  assert.deepEqual(waitingFor(null, "a@b.c"), []);
});

test("what a template asks for that nothing here provides, by placeholder", () => {
  const have = { contact: { name: "Jane" }, record: { name: "Jane" }, project: {} };
  assert.deepEqual(unfilled(["contact.name", "contact.email", "project.title", "brand.name", "client.name", "date"], Object.keys(have)), ["client.name", "date"]);
});

test("how long ago a request was sent, in words", () => {
  const now = Date.UTC(2026, 9, 13, 12);
  assert.equal(whenWords(now - 3 * 3600_000, now), "3 hours ago");
  assert.equal(whenWords(now - 2 * 86400_000, now), "2 days ago");
  assert.equal(whenWords(now - 60_000, now), "just now");
  assert.equal(whenWords(undefined, now), "");
});
