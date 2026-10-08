// @ts-check
// The appmods module inside a real vyred in a temp home with the real Vault, against a fake runtime (the driver is the only fake: Docker is the testbox's job, see team/journals). What this proves:
// only a person installs; the install makes the app's keys in the Vault and never lets one into a result, an event, a log line or a table; the bootstrap's outputs are kept; a webhook with the app's
// token becomes a Vyre event (and a Flow's web trigger when the manifest names one) and one without is refused; remove takes the keys away.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import * as config from "../config/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { seam, handleWebhook, pick } from "./index.js";

const docuseal = () => JSON.parse(fs.readFileSync(new URL("./catalog/docuseal.json", import.meta.url), "utf8"));

async function world(t) {
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
      if (q.url === "/sign_in" && q.method === "GET") return void r.writeHead(200, { "content-type": "text/html", "set-cookie": "sess=anon; path=/; HttpOnly" }).end('<html><head><meta name="csrf-token" content="tok123"></head><body><form action="/sign_in" method="post"><input type="hidden" name="authenticity_token" value="tok123"><input name="user[email]"><input name="user[password]"></form></body></html>');
      if (q.url === "/sign_in" && q.method === "POST") {
        const f = new URLSearchParams(body); seen.sign.push(Object.fromEntries(f));
        const ok = f.get("authenticity_token") === "tok123" && f.get("user[email]") === "vyre+docuseal@vyre.invalid" && f.get("user[password]") === "pw_1234567890abcdef" && /sess=anon/.test(q.headers.cookie || "");
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
    up: async p => { log.push(["up", p.space, p.manifest.name, p.hookPort, Object.keys(p.secrets)]); return { origin: `http://127.0.0.1:${app.address().port}`, gateway: "127.0.0.1", subnet: "127.0.0.0/8", hookHost: "127.0.0.1", _secrets: p.secrets }; },
    exec: async (p, argv, o) => { boot = { argv, env: o.env, files: o.files.map(f => f.name) }; log.push(["exec", argv]); return { code: 0, stdout: "api_token=tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ\nlogin_password=pw_1234567890abcdef\n", stderr: "" }; },
    status: async () => ({ state: "running" }), stop: async () => { log.push(["stop"]); }, down: async (p, o) => { log.push(["down", o]); }, logs: async () => "line",
  };
  seam.driver = driver;
  t.after(() => { seam.driver = null; });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const web = (method, p, { caller = "cli", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: config.paths(root).socket, path: p, method, headers: { host: "localhost", "x-vyre-caller": caller, ...headers } }, res => { const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end(body);
  });
  return { d, root, cli, web, seen, log, lines, boot: () => boot, model: (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" }) };
}

test("the catalog and the card are open to every caller and say what the app may reach", async t => {
  const w = await world(t);
  const c = await w.model("appmods.catalog");
  assert.equal(c.data.apps[0].name, "docuseal");
  assert.equal(c.data.apps[0].installed, false);
  const card = await w.model("appmods.card", { name: "docuseal" });
  assert.deepEqual(card.data.reaches, ["your Vyre, to tell it a document was signed"]);
  assert.equal((await w.model("appmods.card", { name: "nope" })).error.code, "not_found");
});

test("a model cannot install, start, stop or remove an app", async t => {
  const w = await world(t);
  for (const tool of ["appmods.install", "appmods.remove", "appmods.stop", "appmods.start"]) {
    const r = await w.model(tool, { name: "docuseal" });
    assert.ok(r.error, `${tool} was refused for a model: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(w.log, [], "the runtime was never touched");
});

test("install: keys in the Vault, the app started with them, set up by its bootstrap, webhooks become events; no secret anywhere", async t => {
  const w = await world(t);
  const r = await w.cli("appmods.install", { name: "docuseal" });
  assert.deepEqual(r.data, { name: "docuseal", state: "running" }, JSON.stringify(r));
  assert.match(w.log[0][1], /^spc_[a-z2-7]{12}$/);
  assert.deepEqual([w.log[0][0], w.log[0][2]], ["up", "docuseal"]);
  assert.deepEqual(w.log[0][4], ["SECRET_KEY_BASE"]);
  const boot = w.boot();
  assert.deepEqual(boot.argv, ["bin/rails", "runner", "{file}"]);
  assert.deepEqual(boot.files, ["docuseal-bootstrap.rb"]);
  assert.match(boot.env.VYRE_HOOK_URL, /^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  const items = (await w.cli("vault.list", {})).data.items.map(x => x.name).filter(n => n.startsWith("app-docuseal-"));
  assert.deepEqual(items.sort(), ["app-docuseal-api-token", "app-docuseal-hook", "app-docuseal-login-password", "app-docuseal-secret_key_base"].sort().map(n => n === "app-docuseal-secret_key_base" ? "app-docuseal-secret_key_base" : n));
  assert.equal((await w.cli("appmods.list")).data.apps[0].state, "running");
  assert.equal((await w.cli("appmods.screens")).data.screens[0].path, "/");
  assert.equal((await w.cli("appmods.install", { name: "docuseal" })).error.code, "exists");
  // what the Connections module reads: the record the manifest declares, and the Vault item that holds the key (never the key)
  const conn = (await w.cli("appmods.connection", { name: "docuseal" })).data;
  assert.deepEqual([conn.app, conn.label, conn.auth, conn.credential, conn.check], ["docuseal", "DocuSeal", { kind: "header", name: "X-Auth-Token" }, { item: "app-docuseal-api-token", field: "value" }, { method: "GET", path: "/api/user" }]);
  assert.equal(conn.operations[2].name, "submissions.get");
  assert.ok(!JSON.stringify(conn).includes("tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  assert.ok((await w.cli("appmods.origin", { name: "docuseal" })).error, "the origin is for Vyre's own modules, not a person at the terminal");
  assert.match((await w.d.registry.call("appmods.origin", { name: "docuseal" }, "module:connectors", { door: true })).data.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  // nothing secret leaked into what a person or the log can read
  const db = w.d.registry.deps.db;
  const everything = JSON.stringify([r, w.lines, w.d.registry.deps.events.since(0, { limit: 5000 }), db.prepare("SELECT * FROM appmods_apps").all(), await w.cli("appmods.status", { name: "docuseal" })]);
  for (const v of ["tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ", "pw_1234567890abcdef", boot.env.VYRE_HOOK_TOKEN]) assert.ok(!everything.includes(v), `a secret leaked: ${v.slice(0, 8)}`);
});

test("a webhook with the app's token becomes a Vyre event, through the hook tool and through the app's own door; one without is refused", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "docuseal" });
  const token = w.boot().env.VYRE_HOOK_TOKEN;
  const body = { event_type: "submission.completed", timestamp: "2026-10-08T00:00:00Z", data: { id: 7, template: { name: "NDA" }, submitters: [{ email: "a@example.com" }], documents: [{ name: "nda", url: "http://localhost:3000/file/abc/nda.pdf" }] } };
  const bad = await w.d.registry.call("appmods.hook", { name: "docuseal", token: "wrong", body }, "hook");
  assert.equal(bad.error.code, "denied");
  const ok = await w.d.registry.call("appmods.hook", { name: "docuseal", token, body }, "hook");
  assert.ok(ok.data, JSON.stringify(ok));
  assert.equal(ok.data.event, "docuseal.signed", JSON.stringify(ok));
  const ev = w.d.registry.deps.events.since(0, { type: "docuseal.signed" });
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
  assert.equal(w.d.registry.deps.events.since(0, { type: "docuseal.signed" }).length, 2);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-vyre-token": "no", "content-type": "application/json" }, body: "{}" })).status, 403);
  // an event the manifest does not map is ignored, not an error
  assert.deepEqual((await w.d.registry.call("appmods.hook", { name: "docuseal", token, body: { event_type: "template.created" } }, "hook")).data, { ignored: "template.created" });
});

test("handleWebhook starts the Flow the manifest names, once per submission, as an external call", async () => {
  const m = docuseal();
  const started = [];
  const events = [];
  const run = body => handleWebhook({ manifest: m, token: "t", given: "t", body, emit: (t, p) => events.push([t, p]), startFlow: async (p, o) => { started.push([p, o]); return { run: "run_1" }; } });
  const out = await run({ event_type: "submission.completed", data: { id: 3, documents: [] } });
  assert.deepEqual(out, { event: "docuseal.signed", flow: "run_1" });
  assert.equal(started[0][0], "docuseal-signed");
  assert.equal(started[0][1].key, "docuseal.signed:3", "a retried delivery is the same run");
  assert.equal(started[0][1].trust, "external");
  assert.equal(started[0][1].body.submission, 3);
  await assert.rejects(() => handleWebhook({ manifest: m, token: "t", given: "", body: {}, emit() {} }), e => e.code === "denied");
  assert.equal(pick({ a: [{ b: 5 }] }, "a[0].b"), 5);
  assert.equal(pick({}, "a.b"), undefined);
});

test("remove takes the container, the listener and every key; data goes only when asked", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "docuseal" });
  const r = await w.cli("appmods.remove", { name: "docuseal" });
  assert.deepEqual(r.data, { name: "docuseal", removed: true }, JSON.stringify(r));
  assert.deepEqual(w.log.find(x => x[0] === "down")[1], { data: false });
  assert.deepEqual((await w.cli("vault.list", {})).data.items.map(x => x.name).filter(n => n.startsWith("app-docuseal-")), []);
  assert.equal((await w.cli("appmods.list")).data.apps.length, 0);
  assert.equal((await w.cli("appmods.remove", { name: "docuseal" })).error.code, "not_found");
});

test("the app's screens are on the app's own origin: a ticket from Vyre's sign-in buys a cookie for that host only, the app is signed in for the person, nothing of Vyre is on that origin", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "docuseal" });
  const H = "docuseal.localhost:9999";
  const at = (method, p, o = {}) => w.web(method, p, { ...o, headers: { host: H, ...(o.headers || {}) } });
  // no cookie, no word: whoever asks, a person at the terminal included, gets a plain 404 on this origin
  for (const caller of ["cli", "mcp", "hook"]) assert.equal((await at("GET", "/", { caller })).status, 404, caller);
  assert.equal((await at("GET", "/v1/health")).status, 404, "Vyre's API is not on the app's origin");
  assert.equal((await at("GET", "/manifest.json")).status, 200, "a public static path (the manifest lists it) is open without a session: a browser fetches it without cookies");
  assert.equal((await at("POST", "/manifest.json")).status, 404, "and only a GET is open");
  assert.equal((await w.web("GET", "/v1/health", { headers: { host: "localhost" } })).status, 200, "Vyre's own origin is untouched");
  // a model cannot ask for the ticket; the owner can, and gets an address on the app's origin
  assert.ok((await w.model("appmods.open", { name: "docuseal", origin: "http://localhost:9999" })).error);
  const opened = await w.cli("appmods.open", { name: "docuseal", origin: "http://localhost:9999" });
  assert.ok(opened.data, JSON.stringify(opened));
  assert.match(opened.data.url, /^http:\/\/docuseal\.localhost:9999\/__vyre\/enter\?t=[A-Za-z0-9_-]{20,}$/);
  assert.equal(opened.data.host, H);
  assert.deepEqual((await w.cli("appmods.hosts")).data.hosts, ["docuseal.localhost"]);
  const ticket = new URL(opened.data.url).search;
  // the wrong host cannot spend it (and it is gone); a new one is spent once at the right host
  assert.equal((await w.web("GET", "/__vyre/enter" + ticket, { headers: { host: "docuseal.evil.example" } })).status, 404);
  assert.equal((await at("GET", "/__vyre/enter" + ticket)).status, 404, "a ticket that was tried at the wrong host is spent");
  const second = (await w.cli("appmods.open", { name: "docuseal", origin: "http://localhost:9999" })).data.url;
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
  assert.equal(go.headers.location, "http://docuseal.localhost:9999/templates/1");
  const save = await at("POST", "/save", { headers: { ...jar, "content-type": "application/json", origin: "http://" + H, "content-length": "7" }, body: '{"a":1}' });
  assert.equal(save.status, 200, save.text);
  // removing the app ends the sessions and the host
  await w.cli("appmods.remove", { name: "docuseal" });
  assert.notEqual((await at("GET", "/", { headers: jar })).status, 200);
});
