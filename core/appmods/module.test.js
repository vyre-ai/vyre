// @ts-check
// The appmods module inside a real vyred in a temp home with the real Vault, against a fake runtime (the driver is the only fake: Docker is the testbox's job, see team/journals). What this proves:
// only a person installs; the install makes the app's keys in the Vault and never lets one into a result, an event, a log line or a table; the bootstrap's outputs are kept; a webhook with the app's
// token becomes a Vyre event (and a Flow's web trigger when the manifest names one) and one without is refused; remove takes the keys away.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { seam, handleWebhook, pick, connectionForm } from "./index.js";
import { createGate, NOT_FOUND } from "../wink/control/gate.js";

const documents = () => JSON.parse(fs.readFileSync(new URL("./catalog/documents.json", import.meta.url), "utf8"));

async function world(t, opt = {}) {
  const PDF = Buffer.from("%PDF-1.4 signed bytes");
  // A small app that behaves like the real one where it matters: a sign-in form with an anti-forgery token, a session cookie, an origin check on writes, root-absolute links and redirects.
  const seen = { sign: [], reqs: [] };
  const origin = () => `http://127.0.0.1:${app.address().port}`;
  const app = http.createServer((q, r) => {
    seen.reqs.push({ host: q.headers.host || "", method: q.method, url: q.url, cookie: q.headers.cookie || "", origin: q.headers.origin || "", referer: q.headers.referer || "", auth: q.headers.authorization || "", vyre: Object.keys(q.headers).filter(k => k.startsWith("x-vyre")) });
    const authed = /(?:^|; )sess=authed(?:;|$)/.test(q.headers.cookie || "");
    let body = ""; q.on("data", d => { body += d; });
    q.on("end", () => {
      if (q.url === "/file/abc/nda.pdf") return void r.writeHead(200, { "content-type": "application/pdf" }).end(PDF);
      if (q.url === "/api/submissions" && q.method === "POST") {
        seen.api = seen.api || []; seen.api.push({ token: q.headers["x-auth-token"] || "", body });
        if (q.headers["x-auth-token"] !== "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ") return void r.writeHead(401).end();
        return void r.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify([{ id: 7, submission_id: 4411, slug: "abc123", email: "dana@harlow.test" }]));
      }
      if (q.url === "/sign_in" && q.method === "GET") return void r.writeHead(200, { "content-type": "text/html", "set-cookie": "sess=anon; path=/; HttpOnly" }).end('<html><head><meta name="csrf-token" content="tok123"></head><body><form action="/sign_in" method="post"><input type="hidden" name="authenticity_token" value="tok123"><input name="user[email]"><input name="user[password]"></form></body></html>');
      if (q.url === "/sign_in" && q.method === "POST") {
        const f = new URLSearchParams(body); seen.sign.push(Object.fromEntries(f));
        const ok = f.get("authenticity_token") === "tok123" && f.get("user[email]") === "vyre+documents@vyre.invalid" && f.get("user[password]") === "pw_1234567890abcdef" && /sess=anon/.test(q.headers.cookie || "");
        return void r.writeHead(ok ? 302 : 422, { location: "/", ...(ok ? { "set-cookie": "sess=authed; path=/; HttpOnly" } : {}) }).end();
      }
      if (!authed) return void r.writeHead(302, { location: "/sign_in" }).end();
      if (q.url === "/") return void r.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "tracker=1; path=/" }).end(`<html><head><link rel="stylesheet" href="/packs/app.css"><script src="/packs/app.js" defer></script></head><body><a href="/templates/1">T</a><meta property="og:url" content="http://localhost:3000/"></body></html>`);
      if (q.url === "/packs/app.css") return void r.writeHead(200, { "content-type": "text/css" }).end("body{background:url(/img/x.png)}");
      if (q.url === "/manifest.json") return void r.writeHead(200, { "content-type": "application/json" }).end("{}");
      if (q.url === "/packs/app.js") return void r.writeHead(200, { "content-type": "text/javascript" }).end("fetch('/api/x')");
      if (q.url === "/go") return void r.writeHead(302, { location: origin() + "/templates/1" }).end();
      if (q.url === "/save" && q.method === "POST") return void r.writeHead(q.headers.origin === `http://${q.headers.host}` ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify({ got: body }));
      r.writeHead(404).end();
    });
  });
  await new Promise(r => app.listen(0, "127.0.0.1", r));
  t.after(() => app.close());
  const log = [];
  let boot = null;
  const driver = {
    kind: "fake",
    up: async p => { if (opt.upFailsAfter !== undefined && log.filter(l => l[0] === "up").length >= opt.upFailsAfter) throw new Error("the runtime would not start it"); log.push(["up", p.space, p.manifest.name, p.hookPort, Object.keys(p.secrets)]); return { origin: `http://127.0.0.1:${app.address().port}`, gateway: "127.0.0.1", subnet: "127.0.0.0/8", hookHost: "127.0.0.1", _secrets: p.secrets }; },
    exec: async (p, argv, o) => { boot = { argv, env: o.env, files: o.files.map(f => f.name) }; log.push(["exec", argv]); return { code: 0, stdout: "api_token=tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ\nlogin_password=pw_1234567890abcdef\n", stderr: "" }; },
    status: async () => ({ state: "running" }), stop: async () => { log.push(["stop"]); }, down: async (p, o) => { log.push(["down", o]); }, logs: async () => "line",
  };
  // The host-helper driver's shape: root made the keys and ran the setup; the daemon is handed the outputs once and never runs a command in the app.
  const helperDriver = {
    kind: "helper",
    hookPortFor: m => m.app.hookPort,
    up: async p => { log.push(["up", p.space, p.manifest.name, p.hookPort, Object.keys(p.secrets)]); return { origin: `http://127.0.0.1:${app.address().port}`, hookHost: "127.0.0.1", outputs: opt.handoff === false ? null : { hook_token: "h".repeat(64), api_token: "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ", login_password: "pw_1234567890abcdef" } }; },
    exec: async () => { throw new Error("the daemon must not run a command in the app"); },
    status: async () => ({ state: "running" }), stop: async () => { log.push(["stop"]); }, down: async (p, o) => { log.push(["down", o]); }, logs: async () => "line",
  };
  seam.driver = opt.helper ? helperDriver : driver;
  t.after(() => { seam.driver = null; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, ...(opt.config || {}) }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  // The apps' front: a loopback listener that answers by Host (what the public gate carries <module>.<name>.vyre.run to)
  const frontPort = (await d.registry.call("appmods.front", {}, "module:vyred")).data.port;
  const web = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: frontPort, path: p, method, headers: { host: "localhost", ...headers } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end(body);
  });
  return { d, root, cli, web, seen, log, lines, boot: () => boot, model: (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" }) };
}

test("the catalog and the card are open to every caller and say what the app may reach", async t => {
  const w = await world(t);
  const c = await w.model("appmods.catalog");
  assert.equal(c.data.apps[0].name, "documents");
  assert.equal(c.data.apps[0].installed, false);
  const card = await w.model("appmods.card", { name: "documents" });
  assert.deepEqual(card.data.reaches, ["your Vyre, to tell it a document was signed"]);
  assert.equal((await w.model("appmods.card", { name: "nope" })).error.code, "not_found");
});

test("a model cannot install, start, stop or remove an app", async t => {
  const w = await world(t);
  for (const tool of ["appmods.install", "appmods.remove", "appmods.stop", "appmods.start"]) {
    const r = await w.model(tool, { name: "documents" });
    assert.ok(r.error, `${tool} was refused for a model: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(w.log, [], "the runtime was never touched");
});

test("install: keys in the Vault, the app started with them, set up by its bootstrap, webhooks become events; no secret anywhere", async t => {
  const w = await world(t);
  const r = await w.cli("appmods.install", { name: "documents" });
  assert.deepEqual({ ...r.data, kit: typeof r.data.kit }, { name: "documents", state: "running", connection: "documents", kit: "string" }, JSON.stringify(r));
  assert.match(w.log[0][1], /^spc_[a-z2-7]{12}$/);
  assert.deepEqual([w.log[0][0], w.log[0][2]], ["up", "documents"]);
  assert.deepEqual(w.log[0][4], ["SECRET_KEY_BASE"]);
  const boot = w.boot();
  assert.deepEqual(boot.argv, ["bin/rails", "runner", "{file}"]);
  assert.deepEqual(boot.files, ["docuseal-bootstrap.rb"]);
  assert.match(boot.env.VYRE_HOOK_URL, /^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  const items = (await w.cli("vault.list", {})).data.items.map(x => x.name).filter(n => n.startsWith("app-documents-"));
  assert.deepEqual(items.sort(), ["app-documents-api-token", "app-documents-hook", "app-documents-login-password", "app-documents-secret_key_base"].sort().map(n => n === "app-documents-secret_key_base" ? "app-documents-secret_key_base" : n));
  assert.equal((await w.cli("appmods.list")).data.apps[0].state, "running");
  assert.equal((await w.cli("appmods.screens")).data.screens[0].path, "/");
  assert.equal((await w.cli("appmods.install", { name: "documents" })).error.code, "exists");
  // what the Connections module reads: the record the manifest declares, and the Vault item that holds the key (never the key)
  const conn = (await w.cli("appmods.connection", { name: "documents" })).data;
  assert.deepEqual([conn.app, conn.label, conn.auth, conn.credential, conn.check], ["documents", "Documents", { kind: "header", name: "X-Auth-Token" }, { item: "app-documents-api-token", field: "value" }, { method: "GET", path: "/api/user" }]);
  assert.deepEqual(conn.operations.map(o => o.name), ["templates.list", "submissions.list", "submissions.create", "submissions.get", "submissions.documents"]);
  assert.equal(conn.operations[2].input.body.template_id.required, true, "the send operation says what it takes: a view draws its form from this");
  assert.deepEqual(conn.operations[1].input.query.status.enum, ["pending", "completed", "declined", "expired"]);
  assert.ok(!JSON.stringify(conn).includes("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  assert.ok((await w.cli("appmods.origin", { name: "documents" })).error, "the origin is for Vyre's own modules, not a person at the terminal");
  assert.match((await w.d.registry.call("appmods.origin", { name: "documents" }, "module:connectors", { door: true })).data.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  // nothing secret leaked into what a person or the log can read
  const db = w.d.registry.deps.db;
  const everything = JSON.stringify([r, w.lines, w.d.registry.deps.events.since(0, { limit: 5000 }), db.prepare("SELECT * FROM appmods_apps").all(), await w.cli("appmods.status", { name: "documents" })]);
  for (const v of ["tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "pw_1234567890abcdef", boot.env.VYRE_HOOK_TOKEN]) assert.ok(!everything.includes(v), `a secret leaked: ${v.slice(0, 8)}`);
});

test("a webhook with the app's token becomes a Vyre event, through the hook tool and through the app's own door; one without is refused", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "documents" });
  const token = w.boot().env.VYRE_HOOK_TOKEN;
  const body = { event_type: "submission.completed", timestamp: "2026-10-08T00:00:00Z", data: { id: 7, template: { name: "NDA" }, submitters: [{ email: "a@example.com" }], documents: [{ name: "nda", url: "http://localhost:3000/file/abc/nda.pdf" }] } };
  const bad = await w.d.registry.call("appmods.hook", { name: "documents", token: "wrong", body }, "hook");
  assert.equal(bad.error.code, "denied");
  const ok = await w.d.registry.call("appmods.hook", { name: "documents", token, body }, "hook");
  assert.ok(ok.data, JSON.stringify(ok));
  assert.equal(ok.data.event, "documents.signed", JSON.stringify(ok));
  const ev = w.d.registry.deps.events.since(0, { type: "documents.signed" });
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].payload.submission, ev[0].payload.email, ev[0].payload.template], [7, "a@example.com", "NDA"]);
  // the signed document was fetched from the app (never from the host its address names) and put in the Drive folder the owner agreed to
  assert.deepEqual(ev[0].payload.files, [{ path: "Signed/7-nda.pdf", size: 21 }]);
  const read = await w.cli("files.drive.space.read", { path: "Signed/7-nda.pdf" });
  assert.equal(Buffer.from(read.data.base64, "base64").toString(), "%PDF-1.4 signed bytes", JSON.stringify(read).slice(0, 300));
  // the same through the app's own door, a listener on the app network's gateway: found in the install's log as the hook url
  const url = w.boot().env.VYRE_HOOK_URL;
  const res = await fetch(url, { method: "POST", headers: { "x-vyre-token": token, "content-type": "application/json" }, body: JSON.stringify({ ...body, data: { ...body.data, id: 8 } }) });
  assert.equal(res.status, 202);
  assert.equal(w.d.registry.deps.events.since(0, { type: "documents.signed" }).length, 2);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-vyre-token": "no", "content-type": "application/json" }, body: "{}" })).status, 403);
  // a signer who declines: the event carries who, which document and why, and the files of a signed copy are not fetched
  const declined = { event_type: "form.declined", timestamp: "2026-10-08T01:00:00Z", data: { id: 9, email: "b@example.com", decline_reason: "The fee is wrong", template: { name: "NDA" }, submission: { id: 11 } } };
  const dec = await w.d.registry.call("appmods.hook", { name: "documents", token, body: declined }, "hook");
  assert.equal(dec.data && dec.data.event, "documents.declined", JSON.stringify(dec));
  const dev = w.d.registry.deps.events.since(0, { type: "documents.declined" });
  assert.equal(dev.length, 1);
  assert.deepEqual([dev[0].payload.submission, dev[0].payload.email, dev[0].payload.template, dev[0].payload.reason], [11, "b@example.com", "NDA", "The fee is wrong"]);
  assert.equal(w.d.registry.deps.events.since(0, { type: "documents.signed" }).length, 2, "a refusal is not a signature");
  // an event the manifest does not map is ignored, not an error
  assert.deepEqual((await w.d.registry.call("appmods.hook", { name: "documents", token, body: { event_type: "template.created" } }, "hook")).data, { ignored: "template.created" });
});

test("handleWebhook starts the Flow the manifest names, once per submission, as an external call", async () => {
  const m = documents();
  const started = [];
  const events = [];
  const run = body => handleWebhook({ manifest: m, token: "t", given: "t", body, emit: (t, p) => events.push([t, p]), startFlow: async (p, o) => { started.push([p, o]); return { run: "run_1" }; } });
  const out = await run({ event_type: "submission.completed", data: { id: 3, documents: [] } });
  assert.deepEqual(out, { event: "documents.signed", flow: "run_1" });
  assert.equal(started[0][0], "documents-signed");
  assert.equal(started[0][1].key, "documents.signed:3", "a retried delivery is the same run");
  assert.equal(started[0][1].trust, "external");
  assert.equal(started[0][1].body.submission, 3);
  await assert.rejects(() => handleWebhook({ manifest: m, token: "t", given: "", body: {}, emit() {} }), e => e.code === "denied");
  assert.equal(pick({ a: [{ b: 5 }] }, "a[0].b"), 5);
  assert.equal(pick({}, "a.b"), undefined);
});

test("remove takes the container, the listener and every key; data goes only when asked", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "documents" });
  const r = await w.cli("appmods.remove", { name: "documents" });
  assert.deepEqual(r.data, { name: "documents", removed: true }, JSON.stringify(r));
  assert.deepEqual(w.log.find(x => x[0] === "down")[1], { data: false });
  assert.deepEqual((await w.cli("vault.list", {})).data.items.map(x => x.name).filter(n => n.startsWith("app-documents-")), []);
  assert.equal((await w.cli("appmods.list")).data.apps.length, 0);
  assert.equal((await w.cli("appmods.remove", { name: "documents" })).error.code, "not_found");
});

test("the app's screens are on the app's own origin: a ticket from Vyre's sign-in buys a cookie for that host only, the app is signed in for the person, nothing of Vyre is on that origin", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "documents" });
  const H = "documents.localhost:9999";
  const at = (method, p, o = {}) => w.web(method, p, { ...o, headers: { host: H, ...(o.headers || {}) } });
  // no cookie, no word: whoever asks gets a plain 404 on this origin
  assert.equal((await at("GET", "/")).status, 404);
  assert.equal((await at("GET", "/v1/health")).status, 404, "Vyre's API is not on the app's origin");
  assert.equal((await at("GET", "/manifest.json")).status, 200, "a public static path (the manifest lists it) is open without a session: a browser fetches it without cookies");
  assert.equal((await at("POST", "/manifest.json")).status, 404, "and only a GET is open");
  assert.equal((await w.web("GET", "/v1/health", { headers: { host: "localhost" } })).status, 404, "this port is the apps' front and nothing else: Vyre is not on it");
  // a model cannot ask for the ticket; the owner can, and gets an address on the app's origin
  assert.ok((await w.model("appmods.open", { name: "documents", origin: "http://localhost:9999" })).error);
  const opened = await w.cli("appmods.open", { name: "documents", origin: "http://localhost:9999" });
  assert.ok(opened.data, JSON.stringify(opened));
  assert.match(opened.data.url, /^http:\/\/documents\.localhost:9999\/__vyre\/enter\?t=[A-Za-z0-9_-]{20,}$/);
  assert.equal(opened.data.host, H);
  assert.deepEqual((await w.cli("appmods.hosts")).data.hosts, ["documents.localhost"]);
  const ticket = new URL(opened.data.url).search;
  // the wrong host cannot spend it (and it is gone); a new one is spent once at the right host
  assert.equal((await w.web("GET", "/__vyre/enter" + ticket, { headers: { host: "documents.evil.example" } })).status, 404);
  assert.equal((await at("GET", "/__vyre/enter" + ticket)).status, 404, "a ticket that was tried at the wrong host is spent");
  const second = (await w.cli("appmods.open", { name: "documents", origin: "http://localhost:9999" })).data.url;
  const enter = await at("GET", "/__vyre/enter" + new URL(second).search);
  assert.equal(enter.status, 302);
  assert.equal(enter.headers.location, "/");
  const cookie = /vyre_app=([A-Za-z0-9_-]+)/.exec(String(enter.headers["set-cookie"]))[1];
  assert.match(String(enter.headers["set-cookie"]), /HttpOnly; SameSite=Lax/);
  assert.ok(!/Domain=/i.test(String(enter.headers["set-cookie"])), "the cookie is for that host only");
  assert.equal((await at("GET", "/__vyre/enter" + new URL(second).search)).status, 404, "once");
  const jar = { cookie: `vyre_app=${cookie}; __Host-vyre_person=secret` };
  const home = await at("GET", "/", { headers: jar });
  assert.equal(home.status, 200, home.text.slice(0, 200));
  assert.ok(home.text.includes('href="/templates/1"') && home.text.includes("/packs/app.css"), "not one byte of the app is rewritten");
  assert.equal(home.headers["set-cookie"], undefined, "the app's cookies never reach the browser");
  assert.equal(w.seen.sign.length, 1, "the app was signed in once, with the credentials the install kept");
  for (const r of w.seen.reqs) { assert.ok(!r.cookie.includes("vyre") && !r.cookie.includes("secret"), "no Vyre cookie reached the app"); assert.equal(r.auth, ""); assert.deepEqual(r.vyre, []); }
  assert.equal(w.seen.reqs.filter(r => r.url === "/").pop().cookie, "sess=authed");
  assert.equal(w.seen.reqs.filter(r => r.url === "/").pop().host, H, "the app sees the host the person is on");
  // another app's cookie, or none, is nothing here
  assert.equal((await at("GET", "/", { headers: { cookie: "vyre_app=abc" } })).status, 404);
  // a redirect to the app's own address stays on this origin; a write is the person's own origin
  const go = await at("GET", "/go", { headers: jar });
  assert.equal(go.status, 302);
  assert.equal(go.headers.location, "http://documents.localhost:9999/templates/1");
  const save = await at("POST", "/save", { headers: { ...jar, "content-type": "application/json", origin: "http://" + H, "content-length": "7" }, body: '{"a":1}' });
  assert.equal(save.status, 200, save.text);
  // removing the app ends the sessions and the host
  await w.cli("appmods.remove", { name: "documents" });
  assert.notEqual((await at("GET", "/", { headers: jar })).status, 200);
});

test("the Connection form for an app is the Connections module's create form with `app` and no host, and the key is the Vault item the install made", () => {
  const m = documents();
  const form = connectionForm(m, "app-documents-api-token");
  assert.deepEqual(Object.keys(form).sort(), ["app", "check", "credential", "label", "operations", "send"]);
  assert.equal(form.app, "documents");
  assert.deepEqual(form.send, { how: "header", name: "X-Auth-Token" });
  assert.deepEqual(form.credential, { item: "app-documents-api-token", field: "value" });
  assert.deepEqual(form.check, { path: "/api/user" });
  assert.ok(!("base_url" in form) && !("host" in form));
  assert.deepEqual(form.operations.map(o => o.name), ["templates.list", "submissions.list", "submissions.create", "submissions.get", "submissions.documents"]);
  m.connection.auth = { kind: "bearer" }; assert.deepEqual(connectionForm(m, "x").send, { how: "bearer" });
});

test("when the Connection cannot be made the install still works and says the Connection is pending", async t => {
  const w = await world(t);
  // a Connection of that name is already there (someone made one by hand), so the install's own cannot be made
  assert.ok(!(await w.cli("vault.put", { name: "documents-key", kind: "secret", value: "k-123456789012" })).error);
  assert.ok((await w.cli("connectors.connection.create", { ...connectionForm(documents(), "documents-key") })).data);
  const r = await w.cli("appmods.install", { name: "documents" });
  assert.equal(r.data.state, "running");
  assert.equal(r.data.connection, null);
  const row = w.d.registry.deps.db.prepare("SELECT note, connection_id FROM appmods_apps WHERE name = 'documents'").get();
  assert.match(row.note, /^no Connection yet/);
  assert.equal(row.connection_id, null);
});

test("install through the host helper: the hook port is the catalog's, root's hand-over is kept in the Vault, no key is made here and no command is run in the app", async t => {
  const w = await world(t, { helper: true });
  const r = await w.cli("appmods.install", { name: "documents" });
  assert.deepEqual({ ...r.data, kit: typeof r.data.kit }, { name: "documents", state: "running", connection: "documents", kit: "string" }, JSON.stringify(r));
  assert.deepEqual([w.log[0][0], w.log[0][2], w.log[0][3], w.log[0][4]], ["up", "documents", 43001, []], "the catalog's hook port, and no secret handed to the host (root made them)");
  assert.equal(w.log.filter(l => l[0] === "exec").length, 0);
  const items = (await w.cli("vault.list", {})).data.items.map(x => x.name).filter(n => n.startsWith("app-documents-")).sort();
  assert.deepEqual(items, ["app-documents-api-token", "app-documents-hook", "app-documents-login-password"], "the hand-over is in the Vault, and no SECRET_KEY_BASE was made here");
  assert.equal((await w.cli("appmods.list")).data.apps[0].state, "running");
  const all = JSON.stringify([r, w.lines, (await w.cli("appmods.list")).data]);
  assert.ok(!/tok_ABCDEF|pw_1234567890|h{64}/.test(all), "no key in a result or a log line");
  // a later start asks again and needs nothing from the Vault
  assert.equal((await w.cli("appmods.stop", { name: "documents" })).data.state, "stopped");
  assert.equal((await w.cli("appmods.start", { name: "documents" })).data.state, "running");
});

test("install through the host helper: no hand-over from the host is a failed install that says so", async t => {
  const w = await world(t, { helper: true, handoff: false });
  const r = await w.cli("appmods.install", { name: "documents" });
  assert.match(r.error.message, /gave no hand-over/);
  assert.equal((await w.cli("appmods.list")).data.apps[0].state, "failed");
});

test("through the public gate: an app's host reaches the apps' front, the ticket buys the cookie, the app answers, and a host that is not a running app is the gate's plain 404", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "documents" });
  // the gate as the Wink module builds it: the apps' front port and the hosts of the running apps, asked per request
  const apps = async () => {
    const f = await w.d.registry.call("appmods.front", {}, "module:wink"), h = await w.cli("appmods.hosts", {});
    return { port: f.data.port, hosts: h.data.hosts.map(x => x.replace(/:\d+$/, "")) };
  };
  const be = http.createServer((q, r) => { r.writeHead(404).end(); });   // a stand-in for Headscale: it must never be asked
  let asked = 0; be.on("request", () => { asked++; });
  await new Promise(r => be.listen(0, "127.0.0.1", r)); t.after(() => { be.close(); be.closeAllConnections(); });
  const gate = createGate({ upstream: { port: be.address().port }, ingress: { hooks: () => null, share: () => null, apps, appsSuffix: ".localhost" } });
  await gate.listen(); t.after(() => gate.close());
  const gp = gate.address().port;
  const at = (method, p, host, headers = {}) => new Promise((resolve, reject) => {
    const q = http.request({ host: "127.0.0.1", port: gp, path: p, method, headers: { host, ...headers } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() })); });
    q.on("error", reject); q.end();
  });
  assert.equal((await at("GET", "/", "documents.localhost")).status, 404, "no ticket, no cookie: the front's own plain 404");
  const url = (await w.cli("appmods.open", { name: "documents", origin: "http://localhost:9999" })).data.url;
  const enter = await at("GET", "/__vyre/enter" + new URL(url).search, "documents.localhost:9999");
  assert.equal(enter.status, 302, enter.text);
  const cookie = /vyre_app=([A-Za-z0-9_-]+)/.exec(String(enter.headers["set-cookie"]))[1];
  const home = await at("GET", "/", "documents.localhost:9999", { cookie: `vyre_app=${cookie}` });
  assert.equal(home.status, 200, home.text.slice(0, 200));
  assert.ok(home.text.includes('href="/templates/1"'), "the app's page came through the gate untouched");
  // a host that is not a running app: the gate's 404 bytes, and the front is never asked
  const raw = await new Promise(resolve => { const c = net.connect(gp, "127.0.0.1", () => c.write("GET / HTTP/1.1\r\nHost: nothere.localhost\r\nConnection: close\r\n\r\n")); const b = []; c.on("data", d => b.push(d)); c.on("close", () => resolve(Buffer.concat(b))); });
  assert.deepEqual(raw, NOT_FOUND);
  // after the app is stopped its host is not a running app any more
  await w.cli("appmods.stop", { name: "documents" });
  const gone = await new Promise(resolve => { const c = net.connect(gp, "127.0.0.1", () => c.write("GET / HTTP/1.1\r\nHost: documents.localhost\r\nConnection: close\r\n\r\n")); const b = []; c.on("data", d => b.push(d)); c.on("close", () => resolve(Buffer.concat(b))); });
  assert.deepEqual(gone, NOT_FOUND);
  assert.equal(asked, 0, "Headscale was never asked");
});

test("DocuSeal's two Vyre views are valid in the view language, name only operations the Connection declares, and the send is outward", async () => {
  const { checkView } = await import("../../packages/module-sdk/capsule-view.js");
  const mod = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const app = documents();
  const declared = new Set(app.connection.operations.map(o => o.name));
  assert.deepEqual(Object.keys(mod.views), ["documents-waiting", "documents-send"]);
  for (const [id, v] of Object.entries(mod.views)) {
    assert.deepEqual(checkView(`view:${id}`, v, { tools: new Set(), allowed: new Set(["documents.send"]), firstParty: true }), [], id);
    const ops = [];
    (function walk(x) { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") { if (typeof x.operation === "string") ops.push([x.connection, x.operation]); Object.values(x).forEach(walk); } })(v);
    assert.ok(ops.length, id);
    for (const [c, o] of ops) { assert.equal(c, "documents"); assert.ok(declared.has(o), `${id} uses ${o}, which the Connection declares`); }
  }
  assert.equal(app.connection.operations.find(o => o.name === "submissions.create").kind, "send", "a send is held for the person's yes by the Connection itself");
  assert.equal(mod.views["documents-send"].forms.send.submit.outward, true, "the view shows the exact words first");
  assert.equal(mod.views["documents-send"].forms.send.submit.tool, "documents.send", "and sends through Documents: the signing request and the email with its link, one act, because DocuSeal itself has no way out to e-mail anyone");
  assert.equal(mod.views["documents-waiting"].list.input.query.status, "pending");
});

test("DocuSeal's views are listed only while DocuSeal is connected: absent, then present once its Connection exists, then absent again", async t => {
  const w = await world(t);
  const ids = async () => { const l = (await w.cli("views.list", {})).data; return (Array.isArray(l) ? l : l.views || l.commands || []).filter(r => r.module === "appmods").map(r => r.id).sort(); };
  assert.deepEqual(await ids(), [], "DocuSeal is not there: no views");
  assert.equal((await w.cli("views.get", { module: "appmods", command: "documents-waiting" })).error?.code ?? "gone", "not_found", "and asking for one finds nothing");
  assert.ok(!(await w.cli("vault.put", { name: "documents-key", kind: "secret", value: "k-123456789012" })).error);
  const made = await w.cli("connectors.connection.create", { ...connectionForm(documents(), "documents-key") });
  assert.ok(made.data, JSON.stringify(made));
  assert.deepEqual(await ids(), ["documents-send", "documents-waiting"], "connected: both views");
  const frame = (await w.cli("views.get", { module: "appmods", command: "documents-waiting" })).data;
  assert.ok(frame && typeof frame.kind === "string", JSON.stringify(frame).slice(0, 200));
  assert.ok(!(await w.cli("connectors.connection.delete", { id: made.data.id })).error);
  assert.deepEqual(await ids(), [], "removed: the views go with it");
});

test("appmods.signing.request: only the app's own module asks, the app is asked with its key and told to send nothing, and the answer is the signer's link", async t => {
  const w = await world(t);
  assert.equal((await w.d.registry.call("appmods.signing.request", { name: "documents", template_id: 12, email: "dana@harlow.test" }, "module:documents")).error.code, "not_found", "not running yet");
  await w.cli("appmods.install", { name: "documents" });
  const ask = (input, caller = "module:documents") => w.d.registry.call("appmods.signing.request", { name: "documents", template_id: 12, email: "dana@harlow.test", ...input }, caller);
  const r = await ask({ signer: "Dana Harlow" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual([r.data.submission, r.data.slug], [4411, "abc123"]);
  assert.match(r.data.url, /^https?:\/\/documents\..*\/sign\/4411\/abc123$/);
  assert.equal(w.seen.api.length, 1);
  assert.equal(w.seen.api[0].token, "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "the app's own key, kept in the Vault");
  assert.deepEqual(JSON.parse(w.seen.api[0].body), { template_id: 12, send_email: false, submitters: [{ email: "dana@harlow.test", name: "Dana Harlow" }] });
  assert.ok(!JSON.stringify(r).includes("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "the key is not in the answer");
  assert.equal((await ask({}, "module:comms")).error.code, "denied", "another module cannot ask");
  assert.ok((await w.cli("appmods.signing.request", { name: "documents", template_id: 12, email: "dana@harlow.test" })).error, "nor a person at the terminal");
  assert.equal((await ask({ email: "not an address" })).error.code, "bad_input");
  assert.equal((await ask({ template_id: 0 })).error.code, "bad_input");
  assert.equal(w.seen.api.length, 1, "a bad ask never reached the app");
});

test("own domains: the owner points a domain at the signing app, the front answers it by alias and nothing else, and a model or a bad host is refused", async t => {
  const w = await world(t, { config: { relay: { tunnel_url: "wss://edge.test:8443" } } });
  const none = await world(t);
  assert.equal((await none.cli("appmods.domain.add", { host: "sign.firm.example" })).error.code, "not_found", "no app running yet");
  await none.cli("appmods.install", { name: "documents" });
  assert.equal((await none.cli("appmods.domain.add", { host: "sign.firm.example" })).error.code, "unavailable", "no public door on this server");
  await w.cli("appmods.install", { name: "documents" });
  for (const host of ["vyre.run", "x.vyre.run", "10.0.0.1", "nodot", "http://", "xn--a.example"]) assert.equal((await w.cli("appmods.domain.add", { host })).error.code, "bad_input", host);
  assert.ok((await w.model("appmods.domain.add", { host: "sign.firm.example" })).error, "a model cannot point a domain");
  // before: the host is nobody's
  assert.equal((await w.web("GET", "/sign/4411/abc123", { headers: { host: "sign.firm.example" } })).status, 404);
  const added = await w.cli("appmods.domain.add", { host: "https://Sign.Firm.Example/" });
  assert.equal(added.error, undefined, JSON.stringify(added.error));
  assert.deepEqual([added.data.host, added.data.app, added.data.state], ["sign.firm.example", "documents", "waiting"]);
  assert.deepEqual(added.data.records.map(r => [r.type, r.name, r.value]), [["CNAME", "sign.firm.example", "test-box.vyre.run"]], "the challenge record needs the directory's answer, which this box has no name for");
  assert.deepEqual((await w.cli("appmods.domain.list")).data.domains.map(d => [d.host, d.app, d.state]), [["sign.firm.example", "documents", "waiting"]]);
  assert.ok((await w.cli("appmods.hosts")).data.hosts.includes("sign.firm.example"), "the public gate may carry it to the front");
  // after: the signer's pretty link goes to the page, any other host is still nobody's, and the app's own screens still need the person's ticket
  const r = await w.web("GET", "/sign/4411/abc123", { headers: { host: "sign.firm.example" } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/s/abc123");
  assert.equal((await w.web("GET", "/sign/4411/abc123", { headers: { host: "other.firm.example" } })).status, 404);
  assert.equal((await w.web("GET", "/", { headers: { host: "sign.firm.example" } })).status, 404, "the app's own screens are not public on it");
  // a second listing of the same host is one domain; removing it ends it
  assert.equal((await w.cli("appmods.domain.add", { host: "sign.firm.example" })).error, undefined);
  assert.equal((await w.cli("appmods.domain.list")).data.domains.length, 1);
  assert.equal((await w.model("appmods.domain.remove", { host: "sign.firm.example" })).error !== undefined, true);
  assert.deepEqual((await w.cli("appmods.domain.remove", { host: "sign.firm.example" })).data, { host: "sign.firm.example", removed: true });
  assert.equal((await w.web("GET", "/sign/4411/abc123", { headers: { host: "sign.firm.example" } })).status, 404);
  assert.equal((await w.cli("appmods.domain.remove", { host: "sign.firm.example" })).error.code, "not_found");
});

test("a key rotated in the Vault reaches the running app: its container is made again with the new value, its data stays, once for a burst", async t => {
  seam.rotateMs = 20;
  t.after(() => { seam.rotateMs = undefined; });
  const w = await world(t);
  await w.cli("appmods.install", { name: "documents" });
  const ups = () => w.log.filter(l => l[0] === "up").length, downs = () => w.log.filter(l => l[0] === "down");
  const before = ups();
  const names = w.log.find(l => l[0] === "up")[4];
  const until = async (f, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); } };
  assert.ok(names.length > 0, "the app has keys of its own");
  const item = `app-documents-${names[0].toLowerCase()}`;
  await w.d.registry.call("vault.put", { name: item, kind: "secret", value: "a-new-key-0123456789abcdef" }, "cli");
  await w.d.registry.call("vault.put", { name: item, kind: "secret", value: "a-newer-key-0123456789abcdef" }, "cli");
  await until(() => ups() === before + 1);
  assert.deepEqual(downs().at(-1), ["down", { data: false }], "the container goes, its data stays");
  await new Promise(r => setTimeout(r, 150));
  assert.equal(ups(), before + 1, "two changes in a burst are one restart");
  assert.ok(w.d.registry.deps.db.prepare("SELECT 1 FROM appmods_apps WHERE name = 'documents' AND state = 'running'").get());
  // a key that is not one of the app's, or an app that is stopped, is left alone
  await w.d.registry.call("vault.put", { name: "app-documents-hook", kind: "secret", value: "x".repeat(40) }, "cli");
  await w.cli("appmods.stop", { name: "documents" });
  await w.d.registry.call("vault.put", { name: item, kind: "secret", value: "a-third-key-0123456789abcdef" }, "cli");
  await new Promise(r => setTimeout(r, 150));
  assert.equal(ups(), before + 1);
});

test("a key rotated in the Vault whose app will not start again leaves the app stopped, not listed as running", async t => {
  seam.rotateMs = 20;
  t.after(() => { seam.rotateMs = undefined; });
  const w = await world(t, { upFailsAfter: 1 });
  await w.cli("appmods.install", { name: "documents" });
  const names = w.log.find(l => l[0] === "up")[4];
  await w.d.registry.call("vault.put", { name: `app-documents-${names[0].toLowerCase()}`, kind: "secret", value: "a-new-key-0123456789abcdef" }, "cli");
  const t0 = Date.now();
  while (!w.d.registry.deps.db.prepare("SELECT 1 FROM appmods_apps WHERE name = 'documents' AND state = 'stopped'").get()) { if (Date.now() - t0 > 5000) throw new Error("timed out"); await new Promise(r => setTimeout(r, 20)); }
  assert.ok(w.lines.some(l => /documents did not restart with its new key/.test(l)), "the reason is in the log");
});
