// @ts-check
// The outside signer, for real: a browser that knows only the public name opens the signing link through the relay (TLS ends on the box), types a signature and completes; the real signing app records it.
// Proves the host and TLS handling of the public door with the real app's page, its assets, its CSRF token and its form posts (the first run found the browser's POST of the submit was refused: it posts with
// _method=put). Skips itself unless VYRE_APPMODS_LIVE=1 and CHROME_BIN names a Chrome for Testing. Run on a test box with Docker and passwordless sudo:
//   CHROME_BIN=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome VYRE_APPMODS_LIVE=1 node --test core/appmods/outside-signer.live.test.js
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
import { spawn } from "node:child_process";
import tls from "node:tls";
import https from "node:https";
import { createRelay } from "../../relay/node/server.js";
import { relayLink } from "../../core/relay/link.js";
import { keyPair } from "../../core/relay/noise.js";
import { newRouteKey, routeId } from "../../core/relay/wire.js";
import { createTunnelEnd } from "../../lib/publish/tunnel.js";
import { createGate } from "../../core/wink/control/gate.js";
import { selfSigned } from "../../core/wink/control/testing/selfsigned.js";
import { Cdp } from "../../lib/cdp.js";

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

test("an outside signer signs in a real browser through the public door: relay, TLS on the box, the apps' front, the real signing app", { skip: !LIVE, timeout: 900_000 }, async t => {
  const root = tempHome(t);
  // the host the apps' hosts hang from: <app>.localhost:<port> (a browser reaches *.localhost on this machine with no DNS); the port is the apps' front, which listens on it
  const portProbe = http.createServer(); await new Promise(r => portProbe.listen(0, "127.0.0.1", r));
  const bridgePort = /** @type {any} */ (portProbe.address()).port; await new Promise(r => portProbe.close(r));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "appmods-live", vault: { keystore: "file" }, appmods: { base: "harlow.vyre.run", listen: bridgePort } }));
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


  // the request, the way Documents makes it (no e-mail from the app)
  const asked = await d.registry.call("appmods.signing.request", { name: "documents", template_id: Number(tpl.template_id), email: "outside@example.com", signer: "Outside Signer" }, "module:documents");
  assert.ok(!asked.error, JSON.stringify(asked.error));
  const NAME = "harlow.vyre.run", APP_HOST = "documents.harlow.vyre.run";
  assert.equal(new URL(asked.data.url).host, APP_HOST, "the link a signer is e-mailed is on the public host");

  // the public door, in this process: a relay that routes by server name, the box's end, the box's gate with its own certificate in front of the apps' front
  const { cert, key } = selfSigned({ ips: ["127.0.0.1"], names: [NAME, APP_HOST] });
  const gate = createGate({ listen: { host: "127.0.0.1", port: 0 }, tls: { cert, key }, upstream: { port: 9 }, ingress: { hooks: () => null, share: () => null, appsSuffix: `.${NAME}`, apps: () => ({ port: bridgePort, hosts: [APP_HOST] }) } });
  const gateAt = await gate.listen(); t.after(() => gate.close());
  const rk = newRouteKey(), route = routeId(rk.pub);
  const relay = createRelay({ tunnel: { resolve: async h => (h === APP_HOST ? { route } : null), limits: { ttlMs: 0 } } });
  const relayBase = await relay.listen(); const { tls: relayTls } = await relay.listenTunnel(); t.after(() => relay.close());
  const end = createTunnelEnd({ name: NAME, port: () => gateAt.port });
  const rl = relayLink({ url: relayBase, route, routeKey: rk, boxKey: keyPair(), admit: async () => ({ v: 1 }), onchannel: () => {}, ontunnel: (s2, v) => end.accept(s2, v) });
  t.after(() => rl.stop());
  assert.equal(await rl.ready(), true);

  // a real browser (Chrome for Testing, its own profile), told where the public name is, trusting the box's certificate
  const CHROME = process.env.CHROME_BIN;
  assert.ok(CHROME && fs.existsSync(CHROME), "set CHROME_BIN to a Chrome for Testing");
  const prof = fs.mkdtempSync(path.join(root, "chrome-"));
  const child = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${prof}`, "--no-first-run", "--disable-gpu", "--ignore-certificate-errors", `--host-resolver-rules=MAP ${APP_HOST} 127.0.0.1:${relayTls}`, ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore", detached: true });
  t.after(() => { try { process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL"); } catch { /* gone */ } });
  let cport = 0;
  for (let i = 0; i < 400 && !cport; i++) { try { const n = Number(fs.readFileSync(path.join(prof, "DevToolsActivePort"), "utf8").split("\n")[0]); if (n && (await fetch(`http://127.0.0.1:${n}/json/version`)).ok) cport = n; } catch { /* not yet */ } if (!cport) await new Promise(r => setTimeout(r, 100)); }
  assert.ok(cport, "Chrome came up");
  const cdp = new Cdp({ cdpUrl: `http://127.0.0.1:${cport}` });
  await cdp.connect();
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  /** @type {{ url: string, status: number, method?: string }[]} */ const resp = [];
  /** @type {string[]} */ const sent = [];
  cdp.on(m => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.responseReceived") resp.push({ url: m.params.response.url, status: m.params.response.status });
    if (m.method === "Network.requestWillBeSent" && m.params.request.method !== "GET") sent.push(`${m.params.request.method} ${m.params.request.url} ${String(m.params.request.postData || "").slice(0, 160)}`);
  });
  await cdp.send("Network.enable", {}, sessionId); await cdp.send("Page.enable", {}, sessionId); await cdp.send("Runtime.enable", {}, sessionId);
  const ev = async (/** @type {string} */ expression) => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  const shot = async (/** @type {string} */ name) => { const r = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId); fs.writeFileSync(`/tmp/outside-${name}.png`, Buffer.from(r.data, "base64")); };
  const loaded = cdp.waitFor(m => m.sessionId === sessionId && m.method === "Page.loadEventFired", 30_000);
  await cdp.send("Page.navigate", { url: asked.data.url }, sessionId);
  await loaded; await new Promise(r => setTimeout(r, 4000));
  const first = String(await ev("document.body.innerText"));
  assert.match(first, /Vyre proof NDA/, "the page is the signer's, for this document");
  assert.match(first, /Signatures by DocuSeal, open source \(AGPL-3\.0\)/, "the open-source credit is present");
  assert.equal(await ev("location.host"), APP_HOST, "and the browser never left the public name");
  assert.deepEqual(resp.filter(r => r.status >= 400), [], "every request the page made was answered");
  // the signer types a signature and completes, as a person does
  const click = (/** @type {string} */ label) => ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim().toUpperCase() === ${JSON.stringify(label)} && x.offsetParent); if (!b) return false; b.click(); return true; })()`);
  assert.equal(await click("TYPE"), true, "the Type tab is there");
  await new Promise(r => setTimeout(r, 800));
  const focused = await ev("(() => { const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && (x.type === 'text' || !x.type) && !x.readOnly); if (!i) return null; i.focus(); return i.placeholder || i.name || i.id || 'input'; })()");
  assert.ok(focused, "a text field for the typed signature");
  await cdp.send("Input.insertText", { text: "Outside Signer" }, sessionId);
  await new Promise(r => setTimeout(r, 600));
  await shot("typed");
  assert.equal(await click("SIGN AND COMPLETE"), true, "the complete button is there");
  await new Promise(r => setTimeout(r, 5000));
  await shot("done");
  assert.match(String(await ev("document.body.innerText")), /Document has been signed/);
  assert.equal(await ev("[...document.querySelectorAll('download-button')].every(e => getComputedStyle(e).display === 'none')"), true, "no Download button for a file the signer's link does not open (the signed copy comes by its own expiring link)");
  assert.deepEqual(resp.filter(r => r.status >= 400), [], "and nothing the browser sent was refused");
  assert.ok(sent.some(x => x.startsWith("POST ") && new URL(x.split(" ")[1]).pathname === new URL(asked.data.url).pathname.replace(/^\/sign\/\d+/, "/s")), `the browser's submit was posted: ${sent.join(" | ").slice(0, 300)}`);
  const subm = await api("GET", `/api/submissions/${asked.data.submission}`);
  assert.equal(subm.s, 200);
  assert.equal(subm.j.status, "completed", "the signing app recorded the signature: the browser's submit reached it");
});
