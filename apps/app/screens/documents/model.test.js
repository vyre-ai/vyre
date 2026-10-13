// The pure half of the Documents home: made documents as rows and groups, what fills a template's placeholders, the signing templates from the Documents app, and whether the app is installed.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { madeRows, madeGroupOf, MADE_GROUPS, fillsFor, signingTemplates, appState, asRecs } from "./model.js";

const TYPES = [{ name: "contact", label: "Contact", fields: [{ name: "name", label: "Name" }, { name: "email", label: "Email" }] }, { name: "project", label: "Matter", fields: [{ name: "title", label: "Title" }] }];

test("a document record is a row: its name, status, template, file and when", () => {
  const rows = madeRows([{ id: "a", urn: "u/a", created_at: 5, data: { name: "Engagement letter, Doe", status: "Draft", template: "Engagement letter", file: "Documents/doe/engagement-1.docx", submission: 41 } }, { id: "b", urn: "u/b", created_at: 9, data: { name: "Will", status: "Signed" } }]);
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.file, r.submission]), [["Will", "Signed", "", null], ["Engagement letter, Doe", "Draft", "Documents/doe/engagement-1.docx", 41]]);
});

test("a row with no name reads as its template or a plain word, never an id", () => {
  assert.equal(madeRows([{ id: "x1", data: { template: "Will" } }])[0].name, "Will");
  assert.equal(madeRows([{ id: "x1", data: {} }])[0].name, "Document");
});

test("made documents fall in three groups by where they are", () => {
  assert.deepEqual(MADE_GROUPS.map((g) => g[1]), ["Drafts", "Out for signature", "Signed"]);
  assert.equal(madeGroupOf("Draft"), "Drafts");
  assert.equal(madeGroupOf(undefined), "Drafts");
  for (const s of ["Sent", "Out for signature", "Waiting"]) assert.equal(madeGroupOf(s), "Out for signature");
  for (const s of ["Signed", "Completed"]) assert.equal(madeGroupOf(s), "Signed");
});

test("each placeholder of a template says what fills it: an object's field, the firm's brand, or nothing yet", () => {
  const f = fillsFor(["contact.name", "contact.email", "project.title", "brand.name", "client.name", "date", "contact.ssn"], TYPES);
  assert.deepEqual(f.map((x) => [x.placeholder, x.from]), [["contact.name", "Contact, Name"], ["contact.email", "Contact, Email"], ["project.title", "Matter, Title"], ["brand.name", "Firm details"], ["client.name", ""], ["date", ""], ["contact.ssn", ""]]);
  assert.equal(f.filter((x) => !x.from).length, 3);
});

test("the signing templates of the Documents app are read from the operation's answer, whatever wraps it", () => {
  const rows = [{ id: 7, name: "NDA", folder_name: "Legal" }, { id: 9, name: "Engagement" }, { name: "no id" }];
  for (const r of [{ body: { data: rows } }, { data: { body: { data: rows } } }, { body: rows }, rows]) assert.deepEqual(signingTemplates(r).map((x) => [x.id, x.name, x.folder]), [[7, "NDA", "Legal"], [9, "Engagement", ""]]);
  assert.deepEqual(signingTemplates(null), []);
  assert.deepEqual(signingTemplates({ body: "no" }), []);
});

test("the Documents app is installed when appmods.list holds it, running or stopped, and says so", () => {
  assert.deepEqual(appState({ apps: [{ name: "documents", state: "running" }] }), { installed: true, running: true, word: "Running" });
  assert.deepEqual(appState({ apps: [{ name: "documents", state: "stopped" }] }), { installed: true, running: false, word: "Installed, not running" });
  assert.deepEqual(appState({ apps: [{ name: "pdf", state: "running" }] }), { installed: false, running: false, word: "Not installed" });
  assert.deepEqual(appState(null), { installed: false, running: false, word: "Not installed" });
});

test("records go to the list header as records of the made-document type", () => {
  const rows = madeRows([{ id: "a", data: { name: "A", status: "Draft", template: "T" } }]);
  assert.deepEqual(asRecs(rows)[0].data, { name: "A", status: "Draft", template: "T" });
  assert.equal(asRecs(rows)[0].id, "a");
});
