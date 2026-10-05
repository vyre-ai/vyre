// @ts-check
// The two example modules (examples/modules/forms and docgen), written against the public SDK only, installed into a real vyred's modules folder the way `vyre module add` leaves them: they run in
// the sandbox, and their declared verbs reach the Space's records and Drive under the person who installed them, and nothing else. Linux only: the sandbox needs bubblewrap.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "modules");

test("forms and docgen: installed from the examples, a webhook answer becomes a lead, and a template plus a contact becomes a file in the Drive", { skip: process.platform !== "linux" ? "the added-module sandbox needs bwrap (linux)" : false, timeout: 120_000 }, async t => {
  process.env.VYRE_SEAL_DEV = "1";
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", vault: { keystore: "file" } }));
  for (const name of ["forms", "docgen"]) fs.cpSync(path.join(EXAMPLES, name), path.join(root, "modules", name), { recursive: true, filter: s => !s.endsWith("node_modules") });
  const d = await start({ presence: present, root, log: () => {} });
  t.after(() => d.stop());
  for (const name of ["forms", "docgen"]) assert.equal(d.registry.status().find(m => m.name === name)?.state, "running", JSON.stringify(d.registry.status().find(m => m.name === name)));

  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  // forms ships a Kit (does.kits): `vyre module add` proposes it, and its card waits for the person's yes. Here it is proposed the same way and approved by the owner (the dev stand-in), and the
  // type it defines is what lets forms file leads.
  const { call } = await import("../daemon/client.js");
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  const kit = JSON.parse(fs.readFileSync(path.join(root, "modules", "forms", "kits", "forms.json"), "utf8"));
  const proposed = await call("flows.kit.propose", { kit }, { root, caller: "cli" });
  assert.ok(proposed.data && proposed.data.ok !== false, "the module's Kit proposes: " + JSON.stringify(proposed));
  assert.ok(JSON.stringify(proposed.data.card).includes("lead"), "its card says what it adds");
  const f = (/** @type {string} */ name) => ({ name, kind: "text", label: name });
  await d.kernel.gateway.records.define(owner, { add_types: [
    { name: "lead", label: "Lead", fields: [f("name"), f("email"), f("message")] },
    { name: "contact", label: "Contact", fields: [f("name"), f("matter")] },
    { name: "doc_template", label: "Template", fields: [f("name"), f("folder"), f("body")] },
  ] });

  // forms: only the webhook route reaches the tool; the answer is a lead in the Space.
  assert.equal((await d.registry.call("forms.submit", { name: "Dana", email: "dana@harlow.test" }, "local")).error?.code, "no_such_tool", "a person cannot call the webhook tool");
  const got = await d.registry.call("forms.submit", { name: "Dana Reyes", email: "dana@harlow.test", message: "locks changed" }, "hook");
  assert.deepEqual(got.data, { received: true }, JSON.stringify(got));
  const leads = (await d.registry.call("forms.leads", {}, "local")).data;
  assert.deepEqual([leads.count, leads.leads[0].name], [1, "Dana Reyes"]);
  assert.equal((await d.kernel.gateway.records.query(owner, "lead", { page: { limit: 10 } })).rows.length, 1, "it is a real record in the Space");
  assert.ok(d.events.since(0, { type: "forms.answer-received" }).length === 1);

  // docgen: a template and a contact give a file in the declared Drive folder, and nowhere else.
  const tpl = await d.kernel.gateway.records.create(owner, "doc_template", { name: "Engagement letter", folder: "Clients/Harlow", body: "Dear {{name}}, we will handle {{matter}}." });
  const bad = await d.kernel.gateway.records.create(owner, "doc_template", { name: "Payroll", folder: "Finance", body: "x" });
  const dana = await d.kernel.gateway.records.create(owner, "contact", { name: "Dana Reyes", matter: "the lease dispute" });
  const made = await d.registry.call("docgen.make", { template: tpl.urn, record: dana.urn }, "local");
  assert.deepEqual(made.data, { path: "Clients/Harlow/Engagement letter.txt", version: 1 }, JSON.stringify(made));
  const hist = await d.kernel.gateway.drive.history(owner, "Clients/Harlow/Engagement letter.txt");
  assert.equal(hist.length, 1);
  const refused = await d.registry.call("docgen.make", { template: bad.urn, record: dana.urn }, "local");
  assert.ok(refused.error, "a folder outside Clients is refused");
});
