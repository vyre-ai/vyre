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
import { canonical } from "../../kernel/core/canonical.js";
import { startFakeMail } from "../mail/testing/fake-imap.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const LIVE = process.env.VYRE_APPMODS_LIVE === "1";
/** The owner's presence for a test box: the proof must name this op and these exact fields, once (the module-kit upgrade test's stand-in). */
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
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
  const d = await start({ root, presence: present, log: m => { if (process.env.WLOG) console.error(m); }, kernel: true, kernelPresence: stubPresence() });
  const space = d.kernel.id.space;
  const names = namesOf(space, "documents");
  t.after(async () => { try { await d.registry.call("appmods.remove", { name: "documents", data: true }, "cli"); } catch { /* gone */ } docker(["rm", "-f", names.container]); await d.stop(); });
  const cli = (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { proof: { method: "passkey", id: "x" } });
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const ownerMeta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const host = () => d.registry.deps.flowsHost.get(space);

  // a record type for the Flow to write, and the Flow: when DocuSeal says a document was signed, record it
  await d.kernel.gateway.records.define(admin, { add_types: [{ name: "signed_document", label: "Signed document", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "signer", kind: "text", label: "Signer" }, { name: "file", kind: "text", label: "File in the Drive" }] }] });
  const flow = { format: 1, name: "record_signed", label: "Record a signed document", authorship: "human", trigger: { on: "web", path: "documents-signed" },
    steps: [{ id: "c", kind: "create", type: "signed_document", set: { name: { expr: "trigger.template" }, signer: { expr: "trigger.email" }, file: { expr: "trigger.files[0].path" } } }] };
  const def = await d.registry.call("flows.define", { flow }, "cli", await ownerMeta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host().flows.tools["flows.approve"](host().personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });

  // install: the owner's yes. The image is pulled by digest, the container started with its limits, set up with no browser
  const t0 = Date.now();
  const inst = await d.registry.call("appmods.install", { name: "documents" }, "cli", { ...(await ownerMeta()), proof: { method: "passkey", id: "x" } });
  assert.equal(inst.data && inst.data.state, "running", JSON.stringify(inst));
  console.log(`installed in ${Math.round((Date.now() - t0) / 1000)} s`);
  // the Kit the app ships (a Document record type and a Flow that files each signed one) waits for the owner's yes in Now; the owner says yes
  assert.ok(inst.data.kit && inst.data.kit !== "proposed", `the install proposed the Kit: ${JSON.stringify(inst.data)}`);
  const kitRow = await d.kernel.gateway.ask.get(admin, inst.data.kit);
  await d.kernel.gateway.ask.decide(admin, inst.data.kit, { outcome: "approved", proof: { op: "task.decide", fields: { task: inst.data.kit, payload_hash: kitRow.payload.payload_hash, decision: kitRow.payload.decision }, n: Math.random() } });
  await until(async () => ((await d.registry.call("flows.kit.list", {}, "cli", await ownerMeta())).data || []).find(/** @param {any} k */ k => (k.id ?? k.kit_id) === "documents" && k.status === "installed"), "the Documents Kit to install");
  // a Contact the signer's e-mail finds, and a Project (the Document will be linked to the Contact)
  const contact = await d.kernel.gateway.records.create(admin, "contact", { name: "Jo Signer", email: "signer@example.com" });
  const ins = JSON.parse(docker(["inspect", names.container]).stdout)[0];
  assert.equal(ins.HostConfig.Memory, 1536 * 1048576);
  assert.equal(ins.HostConfig.PidsLimit, 512);
  assert.deepEqual(ins.HostConfig.CapDrop, ["ALL"]);
  assert.equal(ins.HostConfig.Privileged, false);
  assert.match(ins.Config.Image, /@sha256:e171808c/);

  // its screens, on the app's own origin (documents.localhost:<port>): a ticket from Vyre's sign-in, the real app's pages signed in for the person, nothing of Vyre on that origin
  const H = `documents.localhost:${bridgePort}`;
  const web = (/** @type {string} */ p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridgePort, path: p, method: "GET", headers: { host: H, ...headers } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end();
  });
  assert.equal((await web("/")).status, 404, "no cookie, no word");
  assert.equal((await web("/v1/health")).status, 404, "Vyre's API is not on the app's origin");
  const opened = await d.registry.call("appmods.open", { name: "documents", origin: `http://localhost:${bridgePort}` }, "cli", await ownerMeta());
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
    const second = await d.registry.call("appmods.open", { name: "documents", origin: `http://localhost:${bridgePort}` }, "cli", await ownerMeta());
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
  const origin = (await cli("appmods.status", { name: "documents" })).data;
  assert.equal(origin.runtime.state, "running");
  const port = /127\.0\.0\.1:(\d+)/.exec(docker(["port", names.container, "3000/tcp"]).stdout)[1];
  const api = async (/** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "X-Auth-Token": tpl.api_token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => null) }; };
  assert.equal((await api("GET", "/api/user")).s, 200, "the app's API answers to the token the bootstrap made");

  // the signature
  const sub = await api("POST", "/api/submissions", { template_id: Number(tpl.template_id), send_email: false, submitters: [{ role: "First Party", email: "signer@example.com" }] });
  assert.equal(sub.s, 200, JSON.stringify(sub.j));
  const submitter = sub.j[0].id;
  // Documents' own way to ask for a signature (documents.send's first half): the app's key stays in the Vault, the engine is told to send nothing, the answer is the signer's page
  {
    const asked = await d.registry.call("appmods.signing.request", { name: "documents", template_id: Number(tpl.template_id), email: "second@example.com", signer: "Second Signer" }, "module:documents");
    assert.ok(!asked.error, JSON.stringify(asked.error));
    assert.ok(Number.isInteger(asked.data.submission) && /^[A-Za-z0-9_-]+$/.test(asked.data.slug), JSON.stringify(asked.data));
    assert.match(asked.data.url, new RegExp(`/sign/${asked.data.submission}/${asked.data.slug}$`));
    const got = await api("GET", `/api/submissions/${asked.data.submission}`);
    assert.equal(got.s, 200, JSON.stringify(got.j).slice(0, 200));
    assert.equal(got.j.submitters[0].email, "second@example.com");
    assert.equal(got.j.send_email === false || got.j.send_email === undefined, true);
    assert.equal((await web(`/sign/${asked.data.submission}/${asked.data.slug}`)).status, 302, "the signer's page opens by the link the tool returned");
  }
  // The signing page for the signer, who has no ticket: the pretty link goes to the page, the page is dressed with Vyre's look and carries the app's credit, every asset it names loads from the same
  // origin, and the owner's pages and the API stay closed to them (R032-02).
  {
    const slug = sub.j[0].slug, subId = sub.j[0].submission_id;
    assert.ok(slug && subId, JSON.stringify(sub.j[0]).slice(0, 200));
    const pretty = await web(`/sign/${subId}/${slug}`);
    assert.equal(pretty.status, 302);
    assert.equal(pretty.headers.location, `/s/${slug}`);
    const signPage = await web(`/s/${slug}`);
    assert.equal(signPage.status, 200, signPage.text.slice(0, 200));
    assert.match(signPage.text, /<link rel="stylesheet" href="\/__vyre\/brand\.css">/);
    assert.ok(signPage.text.includes("Signatures by"), "the app's credit is in the footer");
    assert.equal(signPage.headers["referrer-policy"], "same-origin");
    assert.ok(!/name="user\[password\]"/.test(signPage.text), "a signer is not shown the owner's login");
    const css = await web("/__vyre/brand.css");
    assert.equal(css.status, 200);
    const assets = [...new Set([...signPage.text.matchAll(/(?:href|src)="(\/(?:packs|assets|fonts)\/[^"]+|\/favicon[^"]*|\/apple-icon[^"]*|\/logo\.svg)"/g)].map(m => m[1]))];
    assert.ok(assets.length >= 2, `the signing page names assets: ${assets.join(", ")}`);
    for (const a of assets) assert.equal((await web(a)).status, 200, `the signer can load ${a}`);
    for (const closed of ["/", "/templates", "/submissions", "/api/submissions", "/api/templates", "/settings/api", "/users", "/up"]) assert.equal((await web(closed)).status, 404, `${closed} is closed to a stranger`);
    // a stranger is not the install's admin: the signing page is the signer's view, and the app saw no admin cookie (the page has no "Sign out")
    assert.ok(!/sign_out|Sign out/i.test(signPage.text), "the page is the signer's, not the admin's");
    console.log(`signing page: ${signPage.text.length} bytes, ${assets.length} assets, all public`);
    // With CHROME_BIN set, a real browser opens the signing page with no cookie: every request the page makes must be answered (none refused by the list), and the page must show the credit.
    if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) {
      const { spawn } = await import("node:child_process");
      const { Cdp } = await import("../../lib/cdp.js");
      const dir = fs.mkdtempSync(path.join(root, "chrome-"));
      const child = spawn(process.env.CHROME_BIN, ["--headless=new", "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${dir}`, "--no-first-run", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
      t.after(() => { try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch { /* gone */ } });
      let cport = 0;
      for (let i = 0; i < 400 && !cport; i++) { try { const n = Number(fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").split("\n")[0]); if (n && (await fetch(`http://127.0.0.1:${n}/json/version`)).ok) cport = n; } catch { /* not yet */ } if (!cport) await new Promise(r => setTimeout(r, 50)); }
      assert.ok(cport, "Chrome came up");
      const cdp = new Cdp({ cdpUrl: `http://127.0.0.1:${cport}` });
      await cdp.connect();
      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      /** @type {{ url: string, status: number }[]} */ const resp = []; /** @type {string[]} */ const failed = [];
      cdp.on(m => { if (m.sessionId !== sessionId) return; if (m.method === "Network.responseReceived") resp.push({ url: m.params.response.url, status: m.params.response.status }); if (m.method === "Network.loadingFailed" && !m.params.canceled) failed.push(`${m.params.errorText} ${m.params.requestId}`); });
      await cdp.send("Network.enable", {}, sessionId); await cdp.send("Page.enable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId);
      // the space's brand, as saved by the owner: the signing page must wear it
      const saved = await d.registry.call("brand.set", { profile: { name: "Harlow Legal", colors: { primary: "#3A5BA0" } } }, "cli", { ...(await ownerMeta()), proof: { method: "passkey", id: "x" } });
      assert.ok(!saved.error, JSON.stringify(saved));
      const loaded = cdp.waitFor(m => m.sessionId === sessionId && m.method === "Page.loadEventFired", 30_000);
      await cdp.send("Page.navigate", { url: `http://${H}/sign/${subId}/${slug}` }, sessionId);
      await loaded; await new Promise(r => setTimeout(r, 4000));
      const bad = resp.filter(r => r.status >= 400);
      const text = (await cdp.send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true }, sessionId)).result.value || "";
      try { fs.writeFileSync(`/tmp/sign-page-requests-${process.pid}.json`, JSON.stringify(resp, null, 1)); } catch { /* no copy */ }
      const look = (await cdp.send("Runtime.evaluate", { expression: "JSON.stringify({ band: getComputedStyle(document.body, '::before').content, p: getComputedStyle(document.documentElement).getPropertyValue('--p').trim() })", returnByValue: true }, sessionId)).result.value;
      await cdp.close();
      assert.deepEqual(bad, [], `a real browser on the signing page got errors: ${JSON.stringify(bad).slice(0, 400)}`);
      assert.deepEqual(failed, [], "no request failed");
      assert.ok(text.includes("Signatures by"), "the credit shows in the page");
      const seenLook = JSON.parse(look);
      assert.equal(seenLook.band, '"Harlow Legal"', `the brand's name is on the page: ${look}`);
      assert.match(seenLook.p, /^\d+ \d+% \d+%$/, `the brand's colour is the page's primary: ${look}`);

      console.log(`browser: ${resp.length} requests, none refused`);
    }
  }
  // the Vyre views over DocuSeal's Connection, against the real app: the document just sent is waiting for a signature
  const listed = (await d.registry.call("views.list", {}, "cli", await ownerMeta())).data;
  const vids = (Array.isArray(listed) ? listed : listed.views || listed.commands || []).filter(/** @param {any} r */ r => r.module === "appmods").map(/** @param {any} r */ r => r.id).sort();
  assert.deepEqual(vids, ["documents-send", "documents-waiting"], "DocuSeal is connected: its views are listed");
  const waiting = (await d.registry.call("views.get", { module: "appmods", command: "documents-waiting" }, "cli", await ownerMeta())).data;
  assert.equal(waiting.kind, "list", JSON.stringify(waiting).slice(0, 300));
  assert.ok(waiting.rows.some(/** @param {any} r */ r => /signer@example.com/.test(JSON.stringify(r))), `the waiting view shows the document just sent: ${JSON.stringify(waiting.rows).slice(0, 300)}`);
  const sendList = (await d.registry.call("views.get", { module: "appmods", command: "documents-send" }, "cli", await ownerMeta())).data;
  assert.ok(sendList.rows && sendList.rows.some(/** @param {any} r */ r => /Vyre proof NDA/.test(JSON.stringify(r))), `the send view lists the template: ${JSON.stringify(sendList).slice(0, 300)}`);
  // "Send for signature" from a Contact: the row's action opens the form with the signer's e-mail (the view's q) already in it
  const sendRow = sendList.rows.find(/** @param {any} r */ r => /Vyre proof NDA/.test(JSON.stringify(r)));
  const act = (await d.registry.call("views.act", { module: "appmods", command: "documents-send", action: "send", id: sendRow.id, q: "signer@example.com" }, "cli", await ownerMeta())).data;
  assert.equal(act.kind, "view", JSON.stringify(act).slice(0, 300));
  assert.equal(act.frame.kind, "form");
  assert.equal(act.frame.fields.find(/** @param {any} f */ f => f.name === "email").default, "signer@example.com", "the e-mail is already in the form");
  if (process.env.VYRE_FRAMES_OUT) fs.writeFileSync(process.env.VYRE_FRAMES_OUT, JSON.stringify({ list: sendList, form: act.frame, waiting }));
  // Needs you: the request just sent is waiting; Documents lists it without the signer's code, and the approvals queue holds one quiet card for it
  {
    const wl = await d.registry.call("documents.signing.waiting", {}, "cli", await ownerMeta());
    const mine = wl.data && wl.data.requests.find(/** @param {any} r */ r => r.email === "signer@example.com");
    assert.ok(mine, `the request just sent is waiting: ${JSON.stringify(wl).slice(0, 300)}`);
    assert.equal(mine.template, "Vyre proof NDA");
    assert.ok(!JSON.stringify(wl).includes(sub.j[0].slug), "no signer's code in the list");
    const cards = (await d.registry.call("approvals.items", {}, "cli", await ownerMeta())).data.items.filter(/** @param {any} c */ c => c.kind === "signing" && c.id === `documents:${mine.submission}`);
    assert.equal(cards.length, 1, "one card for it");
    assert.match(cards[0].title, /signer@example\.com has not signed Vyre proof NDA/);
  }
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const done = await api("PUT", `/api/submitters/${submitter}`, { completed: true, values: { Signature: png } });
  assert.equal(done.s, 200, JSON.stringify(done.j));
  {
    // The finished file: the signer's slug does not list or download it, and an expiring link made by Documents does (R032-02 / the signed copy's link).
    const slugDone = sub.j[0].slug;
    for (const p of [`/s/${slugDone}/documents`, `/s/${slugDone}/download`]) assert.equal((await web(p)).status, 404, `${p} is closed to a stranger`);
    const made = await d.registry.call("documents.signed-link", { slug: slugDone, days: 30 }, "cli", { ...(await ownerMeta()), proof: { method: "passkey", id: "x" } });
    assert.ok(made.data && made.data.url, JSON.stringify(made));
    const u = new URL(made.data.url);
    assert.equal(u.host, H);
    const pdfBytes = await new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port: bridgePort, path: u.pathname, method: "GET", headers: { host: H } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }); r.on("error", reject); r.end(); });
    assert.equal(/** @type {any} */ (pdfBytes).status, 200);
    assert.equal(/** @type {any} */ (pdfBytes).body.subarray(0, 5).toString(), "%PDF-", "the link opens the signed PDF");
    assert.equal(/** @type {any} */ (pdfBytes).headers["cache-control"], "no-store");
    assert.equal((await web(u.pathname.replace(/\.[^.]*$/, ".x"))).status, 404, "a changed link opens nothing");
    // the default link has no end: it opens the same file, and it is not under the signer's own address
    const forever = await d.registry.call("documents.signed-link", { slug: slugDone }, "cli", { ...(await ownerMeta()), proof: { method: "passkey", id: "x" } });
    assert.equal(forever.data && forever.data.expires, null, JSON.stringify(forever));
    const fu = new URL(forever.data.url);
    assert.match(fu.pathname, /^\/signed\/0\./);
    const again = await new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port: bridgePort, path: fu.pathname, method: "GET", headers: { host: H } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }); r.on("error", reject); r.end(); });
    assert.equal(/** @type {any} */ (again).status, 200);
    assert.equal(/** @type {any} */ (again).body.subarray(0, 5).toString(), "%PDF-");
  }

  // the event, the Flow's run, the record it made, and the signed PDF in the Drive
  // signed: it is no longer waiting, and its card is closed
  {
    const wl = await d.registry.call("documents.signing.waiting", {}, "cli", await ownerMeta());
    assert.ok(!wl.data.requests.some(/** @param {any} r */ r => r.email === "signer@example.com"), `a signed request is not waiting: ${JSON.stringify(wl).slice(0, 300)}`);
  }
  const ev = await until(async () => { const e = d.registry.deps.events.since(0, { type: "documents.signed" }); return e.length ? e : null; }, "the documents.signed event");
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

  // the Kit's own Flow: a Document record, linked to the Contact the e-mail found, the Contact's timeline, and the signed copy's Drive path
  if (process.env.WLOG) { const fl = (await d.registry.call("flows.list", {}, "cli", await ownerMeta())).data; console.error("FLOWS", JSON.stringify(fl).slice(0, 1200)); for (const f of (Array.isArray(fl) ? fl : fl.flows || [])) { const rr = (await d.registry.call("flows.runs", { id: f.id }, "cli", await ownerMeta())).data; console.error("RUNS", f.name, JSON.stringify(rr).slice(0, 600)); for (const r of rr) console.error("RUN", JSON.stringify((await d.registry.call("flows.run", { run: r.id }, "cli", await ownerMeta())).data.run).slice(0, 1500)); } }
  const docs = await until(async () => { const q = await d.kernel.gateway.records.query(admin, "document", { page: { limit: 5 } }); const rows = Array.isArray(q) ? q : q.rows || q.items || q.records || q.data; return Array.isArray(rows) && rows.length ? rows : null; }, "the Document record the Kit's Flow files");
  const dd = docs[0].data || docs[0];
  assert.equal(dd.name, "Vyre proof NDA");
  assert.equal(dd.status, "Signed");
  assert.equal(dd.signer_email, "signer@example.com");
  assert.equal(dd.file, file.path);
  assert.equal((dd.contact && dd.contact.urn) || dd.contact, contact.urn, `the Document is linked to the signer's Contact: ${JSON.stringify(dd).slice(0, 300)}`);
  const linked = (await d.registry.call("records.linked", { urn: contact.urn }, "cli", await ownerMeta())).data;
  assert.ok(JSON.stringify(linked).includes("Vyre proof NDA") || JSON.stringify(linked).includes(docs[0].urn || "no-urn"), `the Contact shows the Document: ${JSON.stringify(linked).slice(0, 300)}`);
  const timeline = (await d.registry.call("records.events", { record: contact.urn }, "cli", await ownerMeta())).data;
  assert.ok(JSON.stringify(timeline).includes("last_signed_at") || JSON.stringify(timeline).includes(String(docs[0].urn || "x")), `the Contact's timeline has it: ${JSON.stringify(timeline).slice(0, 400)}`);

  // R032-05 with the real engine and a real mail account: a matter enters the stage, the person says yes once to the signing request and its e-mail, the signer signs, the matter moves on, and the signed copy is e-mailed on that same yes.
  const mailbox = await startFakeMail(t, { user: "alex@harlow.example", password: "hunter2-hunter2" });
  const conn = await cli("vault.connect", { module: "mail", need: "imap", label: "alex", fields: { imap_host: "127.0.0.1", imap_port: String(mailbox.imap.port), smtp_host: "127.0.0.1", smtp_port: String(mailbox.smtp.port), username: "alex@harlow.example", password: "hunter2-hunter2", from: "alex@harlow.example", security: "tls" } });
  assert.ok(conn.data && conn.data.item, JSON.stringify(conn));
  await cli("vault.put", { name: conn.data.item, kind: "env-set", fields: { imap_host: "127.0.0.1", imap_port: String(mailbox.imap.port), smtp_host: "127.0.0.1", smtp_port: String(mailbox.smtp.port), username: "alex@harlow.example", password: "hunter2-hunter2", from: "alex@harlow.example", security: "none" } });
  await d.kernel.gateway.records.define(admin, { add_types: [{ name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }, { name: "signature_submission", kind: "text", label: "Signature" },
    { name: "stage", kind: "stage", label: "Stage", options: ["Intake", "Out for signature", "Signed"] }], stages: [{ name: "Intake" }, { name: "Out for signature" }, { name: "Signed" }] }] });
  const signingMade = await cli("documents.signing.flow", { type: "matter", out_stage: "Out for signature", signed_stage: "Signed", template_id: Number(tpl.template_id), name_field: "name" });
  const sdef = await d.registry.call("flows.define", { flow: signingMade.data.flow }, "cli", await ownerMeta());
  assert.ok(sdef.data && sdef.data.ok, JSON.stringify(sdef.data && sdef.data.errors || sdef));
  await host().flows.tools["flows.approve"](host().personChain(), { id: sdef.data.id, version: sdef.data.version, hash: sdef.data.hash });
  /** The held act of this action, answered yes as the person (the Flow's own question is the yes). @param {string} action */
  const sayYes = async action => {
    const task = await until(async () => (await d.kernel.gateway.ask.list(admin, { state: ["needs_check"] })).find(/** @param {any} x */ x => x.form && x.form.kind === "held_act" && x.form.action === action), `the Flow's question for ${action}`);
    const row2 = await d.kernel.gateway.ask.get(admin, task.id);
    await d.kernel.gateway.ask.decide(admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row2.payload.payload_hash, decision: row2.payload.decision }, n: Math.random() } });
  };
  const matter = await d.kernel.gateway.records.create(admin, "matter", { name: "Dana Harlow", email: "dana@harlow.test", stage: "Intake" });
  await d.kernel.gateway.records.update(admin, "matter", matter.id, { stage: "Out for signature" }, matter.version);
  // wait until the run waits on its question before answering it (an answer in the instant before the wait is a race a person never wins)
  await until(async () => { const r = (await d.registry.call("flows.runs", { id: sdef.data.id }, "cli", await ownerMeta())).data; return r && r.length && r[0].state === "waiting"; }, "the signing run to wait on its question");
  await sayYes("documents.send");
  await until(() => mailbox.sent.length === 1, "the signer's e-mail reached the mail server");
  const decode = (/** @type {{ data: string }} */ m) => Buffer.from(m.data.split("\r\n\r\n").slice(1).join("").replace(/\s+/g, ""), "base64").toString();
  assert.deepEqual(mailbox.sent[0].rcpt, ["dana@harlow.test"]);
  const link = /\/sign\/(\d+)\/([A-Za-z0-9_-]+)/.exec(decode(mailbox.sent[0]));
  assert.ok(link, `the e-mail carries the signer's link: ${decode(mailbox.sent[0])}`);
  const submissionId = Number(link[1]);
  assert.equal((await web(`/sign/${link[1]}/${link[2]}`)).status, 302, "and the link opens the signing page");
  // the signer signs (by the app's own API, as the earlier part of this test does)
  const mine = await api("GET", `/api/submissions/${submissionId}`);
  assert.equal(mine.s, 200, JSON.stringify(mine.j).slice(0, 200));
  const sign = await api("PUT", `/api/submitters/${mine.j.submitters[0].id}`, { completed: true, values: { Signature: png } });
  assert.equal(sign.s, 200, JSON.stringify(sign.j).slice(0, 200));
  // the matter moves on by itself, and the signed copy goes out on the second yes
  await until(async () => (await d.kernel.gateway.records.get(admin, "matter", matter.id)).data.stage === "Signed", "the matter to move to Signed");
  assert.equal((await d.kernel.gateway.records.get(admin, "matter", matter.id)).data.signature_submission, String(submissionId));
  // the signed copy rides the yes to the request (`with`): no second question, the e-mail follows the signature on the one yes
  await until(() => mailbox.sent.length === 2, "the signed copy's e-mail reached the mail server, with no second yes");
  const secondAsk = (await d.kernel.gateway.ask.list(admin, { state: ["needs_check"] })).filter(/** @param {any} x */ x => x.form && x.form.kind === "held_act");
  assert.deepEqual(secondAsk.map(/** @param {any} x */ x => x.form.action), [], "nothing is waiting for a second yes");
  const copy = /\/signed\/[A-Za-z0-9_.-]+/.exec(decode(mailbox.sent[1]));
  assert.ok(copy, `the second e-mail carries the signed copy's link: ${decode(mailbox.sent[1])}`);
  const pdf2 = /** @type {any} */ (await new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port: bridgePort, path: copy[0], method: "GET", headers: { host: H } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); }); r.on("error", reject); r.end(); }));
  assert.equal(pdf2.status, 200); assert.equal(pdf2.body.subarray(0, 5).toString(), "%PDF-", "the e-mailed link opens the signed PDF");
  console.log("R032-05 end to end: one yes, two e-mails, the matter moved on");
});
