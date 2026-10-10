// @ts-check
// R032-03 in a real vyred: a document Documents makes is a Document record on its client and project, and it shows on the client's timeline, with no wiring beyond the links it already carries.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { canonical } from "../../kernel/core/canonical.js";
import { tempHome, present } from "../../test/helpers.js";
import { docx } from "./testing/docx.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };

test("a generated document is a Document record on the client and the project, and the client's timeline shows it", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "documents-timeline", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await d.registry.call(tool, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };

  // the Document type exactly as the Documents Kit ships it (its status is a choice without "Draft"; its client and project are links)
  const kit = JSON.parse(fs.readFileSync(new URL("../appmods/catalog/documents.kit.json", import.meta.url), "utf8"));
  await d.kernel.gateway.records.define(admin, { add_types: kit.types.filter((/** @type {any} */ x) => x.name === "document") });
  const contact = await d.kernel.gateway.records.create(admin, "contact", { name: "Dana Harlow", email: "dana@harlow.test" });
  const project = await call("projects.create", { name: "Harlow Estate" });
  /** @type {any} */ let ref = null;
  for (let i = 0; i < 100 && !ref; i++) { try { ref = await call("work.project.ref", { project: project.slug }); } catch { await new Promise(r => setTimeout(r, 200)); } }
  assert.ok(ref, "the project's record");
  const projectUrn = ref.urn || `vyre://${d.kernel.id.space}/project/${ref.id}`;

  await call("documents.template.add", { name: "Engagement letter", base64: docx(["Dear {client.name}, your fee is {fee}."]).toString("base64") });
  const made = await call("documents.generate", { template: "Engagement letter", name: "Engagement letter for Dana Harlow", values: { fee: 1500 }, records: { client: contact.urn }, contact: contact.urn, project: project.slug });
  assert.ok(made.record, `a Document record was filed: ${JSON.stringify(made).slice(0, 300)}`);

  for (const [what, urn] of [["client", contact.urn], ["project", projectUrn]]) {
    const tl = await call("work.timeline", { record: urn });
    const entries = Array.isArray(tl) ? tl : tl.entries || tl.items || [];
    const hit = entries.find((/** @type {any} */ e) => /Engagement letter for Dana Harlow/.test(JSON.stringify(e)));
    assert.ok(hit, `the ${what}'s timeline shows the document: ${JSON.stringify(tl).slice(0, 400)}`);
  }
});

test("the signing Flow documents.signing.flow makes is a Flow a real Space accepts, with its two outward steps in plain view", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "documents-flow", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  await d.kernel.gateway.records.define(admin, { add_types: [{ name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }, { name: "signature_submission", kind: "text", label: "Signature" },
    { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Out for signature", "Signed"] }], stages: [{ name: "Intake" }, { name: "Out for signature" }, { name: "Signed" }] }] });
  const made = await d.registry.call("documents.signing.flow", { type: "matter", out_stage: "Out for signature", signed_stage: "Signed", template_id: 1, name_field: "name" }, "cli", await meta());
  assert.ok(made.data && made.data.flow, JSON.stringify(made));
  const def = await d.registry.call("flows.define", { flow: made.data.flow }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def.data && def.data.errors || def).slice(0, 600));
  assert.deepEqual(def.data.effects.outward.map((/** @type {any} */ x) => x.action), ["documents.send", "documents.send-signed"], "the person approving the Flow sees both sends before it ever runs");
});
