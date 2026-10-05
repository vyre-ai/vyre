// docgen's own tests, on the SDK's testing harness: a fake kernel holds ctx.kernel.records and ctx.kernel.files to what needs.kernel declared.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { testModule } from "../../../packages/module-sdk/testing.js";
import { fill } from "./index.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));
async function docgen(t) { const h = await testModule(DIR); t.after(() => h.stop()); return h; }

test("fill replaces a field the record has and leaves any other as it was", () => {
  assert.equal(fill("Dear {{name}}, your matter {{ matter }} is {{status}}.", { name: "Dana", matter: 42 }), "Dear Dana, your matter 42 is {{status}}.");
});

test("docgen.make fills the template with the record and files it in the declared folder", async t => {
  const h = await docgen(t);
  const tpl = await h.ctx.kernel.records.create("doc_template", { name: "Engagement letter", folder: "Clients/Harlow", body: "Dear {{name}},\nWe will handle {{matter}}." });
  const dana = await h.ctx.kernel.records.create("contact", { name: "Dana Reyes", matter: "the lease dispute" });
  const r = await h.call("docgen.make", { template: tpl.urn, record: dana.urn });
  assert.deepEqual(r.data, { path: "Clients/Harlow/Engagement letter.txt", version: 1 });
  assert.equal(h.files.length, 1);
  assert.equal(h.files[0].text, "Dear Dana Reyes,\nWe will handle the lease dispute.");
  assert.equal((await h.call("docgen.make", { template: tpl.urn, record: dana.urn })).data.version, 2, "a second run is a new version");
  assert.deepEqual(h.events.map(e => e.type), ["docgen.made", "docgen.made"]);
});

test("docgen.make refuses a folder outside what needs.kernel.files lists, and a record it may not read", async t => {
  const h = await docgen(t);
  const bad = await h.ctx.kernel.records.create("doc_template", { name: "x", folder: "Finance/Payroll", body: "x" });
  const dana = await h.ctx.kernel.records.create("contact", { name: "Dana" });
  assert.equal((await h.call("docgen.make", { template: bad.urn, record: dana.urn })).error.code, "undeclared");
  assert.equal(h.files.length, 0, "nothing was written");
  const ok = await h.ctx.kernel.records.create("doc_template", { name: "ok", folder: "Clients/A", body: "x" });
  assert.equal((await h.call("docgen.make", { template: ok.urn, record: "vyre://test/account/r1" })).error.code, "undeclared", "a type it did not declare");
});
