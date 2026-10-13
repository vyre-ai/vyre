// The field list's tokens: the same {object.field} text the Flows composer shows, bare keys, nested link form, and the sections they are listed in.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldTokens, groupedTokens, tokenList } from "./fieldtokens.js";
import { insertList, aliasTable } from "../flows/template.js";

const TYPES = [
  { name: "client", label: "Client", groups: [{ name: "Contact" }, { name: "Case" }], fields: [
    { name: "first_name", label: "First name", kind: "text", group: "Contact" },
    { name: "email", label: "Email", kind: "emails", group: "Contact" },
    { name: "stage", label: "Stage", kind: "stage" },
    { name: "spouse", label: "Spouse", kind: "link", to: "person", group: "Case" },
    { name: "opened", label: "Opened", kind: "date", group: "Case" },
    { name: "notes", label: "Notes", kind: "rich_text" },
  ] },
  { name: "person", label: "Person", fields: [{ name: "name", label: "Name", kind: "text" }] },
];

test("a field's token is the composer's alias, character for character", () => {
  const t = fieldTokens(TYPES[0], TYPES);
  const composer = aliasTable(insertList({ trigger: { kind: "created", type: "client" }, steps: [] }, "", { types: TYPES }, {})).map((r) => r.alias);
  assert.equal(t.first_name.token, "{client.first_name}");
  for (const f of ["first_name", "email", "opened", "notes"]) assert.ok(composer.includes(t[f].token), f);
  assert.equal(t.email.key, "email");
});

test("a link field shows the nested form and names the object it reaches", () => {
  const t = fieldTokens(TYPES[0], TYPES);
  assert.equal(t.spouse.token, "");
  assert.deepEqual(t.spouse.nested, { form: "{client.spouse.field}", target: "Person" });
});

test("fields come in the object's sections: ungrouped first, then each group in order", () => {
  const g = groupedTokens(TYPES[0], TYPES);
  assert.deepEqual(g.map((s) => s.group), ["", "Contact", "Case"]);
  assert.deepEqual(g[0].rows.map((r) => r.label), ["Notes"]);
  assert.deepEqual(g[1].rows.map((r) => r.label), ["First name", "Email"]);
});

test("an object with no groups is one flat section in its own order", () => {
  const g = groupedTokens(TYPES[1], TYPES);
  assert.equal(g.length, 1);
  assert.equal(g[0].group, "");
  assert.deepEqual(g[0].rows.map((r) => r.token), ["{person.name}"]);
});

test("the copy-all list is label and token pairs under each group heading", () => {
  assert.equal(tokenList(TYPES[0], TYPES), "Notes: {client.notes}\n\nContact\nFirst name: {client.first_name}\nEmail: {client.email}\n\nCase\nOpened: {client.opened}");
  assert.equal(tokenList(TYPES[1], TYPES), "Name: {person.name}");
});
