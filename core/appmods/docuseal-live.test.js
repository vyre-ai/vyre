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
import http from "node:http";
import { spawnSync, execFile } from "node:child_process";
import * as config from "../config/index.js";
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
  // the host the apps' hosts hang from: <app>.localhost:<port> (a browser reaches *.localhost on this machine with no DNS); the port is the apps' front, which listens on it
  const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, "127.0.0.1", r));
  const bridgePort = /** @type {any} */ (portProbe.address()).port; await new Promise(r => portProbe.close(r));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "appmods-live", vault: { keystore: "file" }, appmods: { base: `localhost:${bridgePort}`, listen: bridgePort } }));
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
  assert.equal(inst.data && inst.data.state, "running", JSON.stringify(inst));
  console.log(`installed in ${Math.round((Date.now() - t0) / 1000)} s`);
  const ins = JSON.parse(docker(["inspect", names.container]).stdout)[0];
  assert.equal(ins.HostConfig.Memory, 1536 * 1048576);
  assert.equal(ins.HostConfig.PidsLimit, 512);
  assert.deepEqual(ins.HostConfig.CapDrop, ["ALL"]);
  assert.equal(ins.HostConfig.Privileged, false);
  assert.match(ins.Config.Image, /@sha256:e171808c/);

  // its screens, on the app's own origin (docuseal.localhost:<port>): a ticket from Vyre's sign-in, the real app's pages signed in for the person, nothing of Vyre on that origin
  const H = `docuseal.localhost:${bridgePort}`;
  const web = (/** @type {string} */ p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridgePort, path: p, method: "GET", headers: { host: H, ...headers } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end();
  });
  assert.equal((await web("/")).status, 404, "no cookie, no word");
  assert.equal((await web("/v1/health")).status, 404, "Vyre's API is not on the app's origin");
  const opened = await d.registry.call("appmods.open", { name: "docuseal", origin: `http://localhost:${bridgePort}` }, "cli", await ownerMeta());
  assert.ok(opened.data, JSON.stringify(opened));
  assert.equal(new URL(opened.data.url).host, H);
  const enter = await web(new URL(opened.data.url).pathname + new URL(opened.data.url).search);
  assert.equal(enter.status, 302);
  const jar = { cookie: String(enter.headers["set-cookie"]).split(";")[0] };
  let page = await web(enter.headers.location, jar);
  for (let hop = 0; hop < 4 && page.status >= 300 && page.status < 400; hop++) page = await web(page.headers.location.replace(`http://${H}`, ""), jar);
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.ok(!/name="user\[password\]"/.test(page.text), "the person is already signed in to the app: no second login");
  assert.ok(/href="\/packs\/css\//.test(page.text), "the app's page is exactly as the app made it");
  assert.equal(page.headers["set-cookie"], undefined);
  console.log(`screens: ${page.text.length} bytes of the app's own page on ${H}`);

  // With VYRE_APPMODS_BROWSER=1 a real browser (puppeteer's image, on the host network) opens the address straight on the apps' front (Chrome sends *.localhost to this machine) and walks to a second
  // screen. Every request the page makes must go to the app's origin and none may fail; and from the app's page Vyre's address (the same port, no app host) must give nothing.
  if (process.env.VYRE_APPMODS_BROWSER === "1") {
    const seenReq = [];
    const second = await d.registry.call("appmods.open", { name: "docuseal", origin: `http://localhost:${bridgePort}` }, "cli", await ownerMeta());
    const out = path.join(root, "browser"); fs.mkdirSync(out, { recursive: true }); fs.chmodSync(out, 0o777);
    fs.copyFileSync(new URL("./browser-probe.cjs", import.meta.url), path.join(root, "probe.cjs"));
    const run = await new Promise(res => execFile("docker", ["run", "--rm", "--network", "host", "-v", `${path.join(root, "probe.cjs")}:/home/pptruser/probe.cjs:ro`, "-v", `${out}:/out`, "ghcr.io/puppeteer/puppeteer:latest", "node", "/home/pptruser/probe.cjs", second.data.url, `http://localhost:${bridgePort}`], { encoding: "utf8", timeout: 240_000 }, (err, stdout, stderr) => res({ stdout: String(stdout || ""), stderr: String(stderr || "") })));
    const rep = JSON.parse(run.stdout.trim().split("\n").pop() || "{}");
    console.log("browser: " + JSON.stringify(rep).slice(0, 1800)); if (rep.crash) console.log("bridge saw: " + seenReq.join(" | ").slice(0, 3000) + " stderr: " + String(run.stderr).slice(0, 500));
    try { fs.copyFileSync(path.join(out, "page.png"), `/tmp/appmods-page-${process.pid}.png`); } catch { /* no picture */ }
    assert.ok(!rep.crash, rep.crash);
    assert.equal(rep.first.sawLogin, false, "no second login in a real browser");
    assert.deepEqual(rep.outside, [], "every request the page made went to the app's origin");
    assert.deepEqual(rep.failed, [], "no request failed");
    assert.deepEqual(rep.statuses, {}, "no request answered with an error");
    assert.deepEqual(rep.errors, [], "the console holds no error");
    assert.equal(rep.vyreFromApp, "blocked", "the app's origin cannot read Vyre (no cookie crosses, and no Vyre route is there)");
    if (rep.second) assert.equal(new URL(rep.second.url).host, H, "the second screen is on the app's origin too");
  }

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
  // the Vyre views over DocuSeal's Connection, against the real app: the document just sent is waiting for a signature
  const listed = (await d.registry.call("views.list", {}, "cli", await ownerMeta())).data;
  const vids = (Array.isArray(listed) ? listed : listed.views || listed.commands || []).filter(/** @param {any} r */ r => r.module === "appmods").map(/** @param {any} r */ r => r.id).sort();
  assert.deepEqual(vids, ["docuseal-send", "docuseal-waiting"], "DocuSeal is connected: its views are listed");
  const waiting = (await d.registry.call("views.get", { module: "appmods", command: "docuseal-waiting" }, "cli", await ownerMeta())).data;
  assert.equal(waiting.kind, "list", JSON.stringify(waiting).slice(0, 300));
  assert.ok(waiting.rows.some(/** @param {any} r */ r => /signer@example.com/.test(JSON.stringify(r))), `the waiting view shows the document just sent: ${JSON.stringify(waiting.rows).slice(0, 300)}`);
  const sendList = (await d.registry.call("views.get", { module: "appmods", command: "docuseal-send" }, "cli", await ownerMeta())).data;
  assert.ok(sendList.rows && sendList.rows.some(/** @param {any} r */ r => /Vyre proof NDA/.test(JSON.stringify(r))), `the send view lists the template: ${JSON.stringify(sendList).slice(0, 300)}`);
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
