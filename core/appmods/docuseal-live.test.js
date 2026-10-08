// @ts-check
// DocuSeal for real: the pinned image in a container on this machine, installed on the owner's yes, a document signed through its API, the signature arriving as a webhook, a Flow started by it, and the
// signed PDF in the Space's Drive. Skips itself unless VYRE_APPMODS_LIVE=1. Run it on a test box that has Docker and passwordless sudo (the hook door is one firewall rule, added and removed by the driver):
//   VYRE_APPMODS_LIVE=1 node --test core/appmods/docuseal-live.test.js
// The template (the document to sign) is made inside the container with the app's own code, because DocuSeal's open-source API cannot create one; a person makes theirs in the app's screen.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { namesOf } from "./runtime.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const LIVE = process.env.VYRE_APPMODS_LIVE === "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 60_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 500)); } };
const docker = (/** @type {string[]} */ a, input) => spawnSync("docker", a, { encoding: "utf8", ...(input ? { input } : {}) });

const TEMPLATE = `require "hexapdf"
acct = Account.first; user = acct.users.first
doc = HexaPDF::Document.new
doc.pages.add.canvas.font("Helvetica", size: 14).text("Vyre proof agreement. Sign below.", at: [50, 700])
doc.write("/tmp/proof.pdf")
t = Template.new(account: acct, author: user, name: "Vyre proof NDA", folder: TemplateFolders.find_or_create_by_name(user, "Default"), schema: [], fields: [], submitters: [])
sub = SecureRandom.uuid
t.submitters = [{ "name" => "First Party", "uuid" => sub }]
t.save!
file = ActionDispatch::Http::UploadedFile.new(tempfile: File.open("/tmp/proof.pdf"), filename: "proof.pdf", type: "application/pdf")
docs, _ = Templates::CreateAttachments.call(t, { files: [file] }, extract_fields: false)
d = docs.first
t.schema = [{ "attachment_uuid" => d.uuid, "name" => "proof" }]
t.fields = [{ "uuid" => SecureRandom.uuid, "submitter_uuid" => sub, "name" => "Signature", "type" => "signature", "required" => true, "areas" => [{ "x" => 0.1, "y" => 0.8, "w" => 0.3, "h" => 0.06, "page" => 0, "attachment_uuid" => d.uuid }] }]
t.save!
puts "template_id=#{t.id}"
puts "api_token=#{AccessToken.first.token}"
`;

test("DocuSeal signs a document, the signature starts a Flow, and the signed PDF is in the Drive", { skip: !LIVE, timeout: 900_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "appmods-live", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: m => { if (process.env.WLOG) console.error(m); }, kernel: true });
  const space = d.kernel.id.space;
  const names = namesOf(space, "docuseal");
  t.after(async () => { try { await d.registry.call("appmods.remove", { name: "docuseal", data: true }, "cli"); } catch { /* gone */ } docker(["rm", "-f", names.container]); await d.stop(); });
  const cli = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { proof: { method: "passkey", id: "x" } });
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const ownerMeta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const host = () => d.registry.deps.flowsHost.get(space);

  // a record type for the Flow to write, and the Flow: when DocuSeal says a document was signed, record it
  await d.kernel.gateway.records.define(admin, { add_types: [{ name: "signed_document", label: "Signed document", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "signer", kind: "text", label: "Signer" }, { name: "file", kind: "text", label: "File in the Drive" }] }] });
  const flow = { format: 1, name: "record_signed", label: "Record a signed document", authorship: "human", trigger: { on: "web", path: "docuseal-signed" },
    steps: [{ id: "c", kind: "create", type: "signed_document", set: { name: { expr: "trigger.template" }, signer: { expr: "trigger.email" }, file: { expr: "trigger.files[0].path" } } }] };
  const def = await d.registry.call("flows.define", { flow }, "cli", await ownerMeta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host().flows.tools["flows.approve"](host().personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });

  // install: the owner's yes. The image is pulled by digest, the container started with its limits, set up with no browser
  const t0 = Date.now();
  const inst = await cli("appmods.install", { name: "docuseal" });
  assert.deepEqual(inst.data, { name: "docuseal", state: "running" }, JSON.stringify(inst));
  console.log(`installed in ${Math.round((Date.now() - t0) / 1000)} s`);
  const ins = JSON.parse(docker(["inspect", names.container]).stdout)[0];
  assert.equal(ins.HostConfig.Memory, 1536 * 1048576);
  assert.equal(ins.HostConfig.PidsLimit, 512);
  assert.deepEqual(ins.HostConfig.CapDrop, ["ALL"]);
  assert.equal(ins.HostConfig.Privileged, false);
  assert.match(ins.Config.Image, /@sha256:e171808c/);

  // a document to sign (test fixture), then the app's API with its own token
  const id = docker(["inspect", "-f", "{{.Id}}", names.container]).stdout.trim();
  assert.ok(id);
  fs.writeFileSync(path.join(root, "tpl.rb"), TEMPLATE);
  assert.equal(docker(["cp", path.join(root, "tpl.rb"), `${names.container}:/tmp/tpl.rb`]).status, 0);
  const made = docker(["exec", "-w", "/app", names.container, "bin/rails", "runner", "/tmp/tpl.rb"]);
  const tpl = Object.fromEntries(made.stdout.split("\n").map(l => l.split("=")).filter(x => x.length === 2));
  assert.ok(tpl.template_id && tpl.api_token, made.stdout + made.stderr);
  const origin = (await cli("appmods.status", { name: "docuseal" })).data;
  assert.equal(origin.runtime.state, "running");
  const port = /127\.0\.0\.1:(\d+)/.exec(docker(["port", names.container, "3000/tcp"]).stdout)[1];
  const api = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "X-Auth-Token": tpl.api_token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  assert.equal((await api("GET", "/api/user")).s, 200, "the app's API answers to the token the bootstrap made");

  // the signature
  const sub = await api("POST", "/api/submissions", { template_id: Number(tpl.template_id), send_email: false, submitters: [{ role: "First Party", email: "signer@example.com" }] });
  assert.equal(sub.s, 200, JSON.stringify(sub.j));
  const submitter = sub.j[0].id;
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const done = await api("PUT", `/api/submitters/${submitter}`, { completed: true, values: { Signature: png } });
  assert.equal(done.s, 200, JSON.stringify(done.j));

  // the event, the Flow's run, the record it made, and the signed PDF in the Drive
  const ev = await until(async () => { const e = d.registry.deps.events.since(0, { type: "docuseal.signed" }); return e.length ? e : null; }, "the docuseal.signed event");
  assert.equal(ev[0].payload.email, "signer@example.com");
  assert.equal(ev[0].payload.template, "Vyre proof NDA");
  assert.equal(ev[0].payload.files.length, 1);
  const file = ev[0].payload.files[0];
  assert.match(file.path, /^Signed\/\d+-proof\.pdf$/);
  const runs = await until(async () => { const r = (await d.registry.call("flows.runs", { id: def.data.id }, "cli", await ownerMeta())).data; return r && r.length ? r : null; }, "the Flow's run");
  const run = (await d.registry.call("flows.run", { run: runs[0].id }, "cli", await ownerMeta())).data.run;
  assert.equal(run.trigger.kind, "web", "the run says what started it");
  await until(async () => (await d.registry.call("flows.run", { run: runs[0].id }, "cli", await ownerMeta())).data.run.state === "done", "the run to finish");
  const lastRun = (await d.registry.call("flows.run", { run: runs[0].id }, "cli", await ownerMeta())).data.run;
  let seen = null;
  const rec = await until(async () => { const q = await d.kernel.gateway.records.query(admin, "signed_document", { page: { limit: 5 } }); seen = q; const rows = Array.isArray(q) ? q : q.rows || q.items || q.records || q.data; return Array.isArray(rows) && rows.length ? rows : null; }, "the record the Flow made", 10_000).catch(e => { throw new Error(`${e.message}; query gave ${JSON.stringify(seen).slice(0, 300)}; run ${JSON.stringify(lastRun).slice(0, 900)}`); });
  const row = rec[0].data || rec[0];
  assert.equal(row.name, "Vyre proof NDA");
  assert.equal(row.signer, "signer@example.com");
  assert.equal(row.file, file.path);
  const pdf = await d.registry.call("files.drive.space.read", { path: file.path }, "cli", await ownerMeta());
  assert.ok(pdf.data, JSON.stringify(pdf));
  const bytes = Buffer.from(pdf.data.base64, "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-", "the Drive holds a PDF");
  assert.ok(bytes.length > 1000, `the signed PDF has content (${bytes.length} bytes)`);
  console.log(`signed PDF in the Drive: ${file.path}, ${bytes.length} bytes; Flow run ${runs[0].id}`);
});
