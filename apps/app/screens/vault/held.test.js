// @ts-check
// Vault's Held fields and Share: which sealed values are held (read from the records, never a value), grouped by record, and the vault.grant input.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const types = [
  { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "ssn", kind: "sealed", label: "SSN" }, { name: "dob", kind: "date", label: "Date of birth", seal: { level: "ai", class: "free" } }, { name: "email", kind: "text", label: "Email" }] },
  { name: "trip", label: "Trip", fields: [{ name: "title", kind: "text", label: "Title" }] },
];
const byType = {
  contact: [
    { urn: "vyre://s/contact/1", data: { name: "Jane Doe", ssn: { sealed: "ssn", ref: "r1", present: true }, dob: { sealed: "dob", ref: "r2", present: true }, email: "j@x.test" } },
    { urn: "vyre://s/contact/2", data: { name: "Empty", ssn: { sealed: "ssn", present: false } } },
    { urn: "vyre://s/contact/3", data: { name: "Placeholder", ssn: { sealed: "ssn" } } },
    { urn: "vyre://s/contact/4", data: { name: "None" } },
  ],
  trip: [{ urn: "vyre://s/trip/1", data: { title: "Lisbon" } }],
};

test("held fields: a row per sealed value a person may reveal, named by record and field, with no value in it", { skip: !strip }, async () => {
  const { heldFields, heldLine } = await import("./held-model.ts");
  const rows = heldFields(types, byType);
  assert.deepEqual(rows.map((r) => [r.title, r.field, r.label]), [["Jane Doe", "ssn", "SSN"], ["Jane Doe", "dob", "Date of birth"]]);
  assert.equal(rows[0].id, "vyre://s/contact/1/ssn");
  assert.match(heldLine(rows[0]), /Assistants read "SSN on file, sealed"/);
  for (const r of rows) assert.ok(!JSON.stringify(r).includes("r1") && !JSON.stringify(r).includes("r2"), "a reference is not carried into the row");
  assert.deepEqual(heldFields([], {}), []);
});

test("held fields group under one record", { skip: !strip }, async () => {
  const { heldFields, heldByRecord } = await import("./held-model.ts");
  const g = heldByRecord(heldFields(types, byType));
  assert.equal(g.length, 1);
  assert.equal(g[0].title, "Jane Doe");
  assert.deepEqual(g[0].fields.map((f) => f.field), ["ssn", "dob"]);
});

test("share: vault.grant gets the item, the module, an optional watcher and project; bad names are said plainly", { skip: !strip }, async () => {
  const { shareInput, shareNote, shareRefusal } = await import("./held-model.ts");
  assert.deepEqual(shareInput("Gmail", { module: "mail", project: "" }), { input: { name: "Gmail", module: "mail" } });
  assert.deepEqual(shareInput("Gmail", { module: " watch/intake ", project: " juniper " }), { input: { name: "Gmail", module: "watch", watcher: "intake", project: "juniper" } });
  assert.match(/** @type {any} */ (shareInput("Gmail", { module: "", project: "" })).error, /Say who gets it/);
  assert.match(/** @type {any} */ (shareInput("Gmail", { module: "two words", project: "" })).error, /no spaces/);
  assert.match(shareNote("mail", "Gmail", { grant: { status: "active" } }), /mail can now use Gmail\. It never sees the value/);
  assert.match(shareNote("mail", "Gmail", { grant: { status: "pending" } }), /waits for your yes/);
  assert.match(shareRefusal("presence_required", ""), /Approve on this device/);
  assert.equal(shareRefusal("weird", "box words"), "box words");
});

test("share goes through vault.grant on the box and nothing else", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  /** @type {any[]} */ const seen = [];
  const src = vaultSource(async (tool, input) => { seen.push({ tool, input }); return { data: { grant: { status: "active" } } }; });
  const r = await src.grantReal({ name: "Gmail", module: "mail" });
  assert.deepEqual(seen, [{ tool: "vault.grant", input: { name: "Gmail", module: "mail" } }]);
  assert.equal(r.grant?.status, "active");
});

test("a held field's reveal is records.reveal with the purpose, answered by the app's own presence, and no simulated proof anywhere", { skip: !strip }, async () => {
  const { vaultSource } = await import("./source.ts");
  /** @type {any[]} */ const seen = [];
  const src = vaultSource(async (tool, input) => { seen.push({ tool, input }); return { data: { value: "123-45-6789" } }; });
  assert.equal(await src.revealHeldReal("urn:x", "ssn", "view"), "123-45-6789");
  assert.deepEqual(seen, [{ tool: "records.reveal", input: { urn: "urn:x", field: "ssn", purpose: "view" } }]);
  const wrapped = vaultSource(async () => ({ data: { field: { value: "abc" } } }));
  assert.equal(await wrapped.revealHeldReal("u", "f", "p"), "abc");
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(new URL("./RealVault.tsx", import.meta.url), "utf8").includes("simulatedProof"), false);
});
