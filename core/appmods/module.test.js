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
    seen.reqs.push({ method: q.method, url: q.url, cookie: q.headers.cookie || "", origin: q.headers.origin || "", referer: q.headers.referer || "", auth: q.headers.authorization || "", vyre: Object.keys(q.headers).filter(k => k.startsWith("x-vyre")) });
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
      if (q.url === "/packs/app.js") return void r.writeHead(200, { "content-type": "text/javascript" }).end("fetch('/api/x')");
      if (q.url === "/go") return void r.writeHead(302, { location: origin() + "/templates/1" }).end();
      if (q.url === "/save" && q.method === "POST") return void r.writeHead(q.headers.origin === origin() ? 200 : 403, { "content-type": "application/json" }).end(JSON.stringify({ got: body }));
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

test("the app's screens are served under /m/<module>/ for a signed-in person only, signed in to the app for them, with the app's cookies and Vyre's kept apart", async t => {
  const w = await world(t);
  await w.cli("appmods.install", { name: "docuseal" });
  // not a person: a model, and a hook, are told nothing
  for (const caller of ["mcp", "hook", "harness"]) assert.equal((await w.web("GET", "/m/docuseal/", { caller })).status, 404, caller);
  assert.equal((await w.web("GET", "/m/nothing/", {})).status, 404, "an app that is not installed is not there");
  const home = await w.web("GET", "/m/docuseal/", { headers: { cookie: "__Host-vyre_person=secret; other=1", authorization: "Bearer vyre-secret", "x-vyre-proof": "p" } });
  assert.equal(home.status, 200, home.text.slice(0, 200));
  assert.match(home.text, /<head><script src="\/m\/docuseal\/__vyre\/shim\.js"><\/script>/);
  assert.match(home.text, /href="\/m\/docuseal\/packs\/app\.css"/);
  assert.match(home.text, /href="\/m\/docuseal\/templates\/1"/);
  assert.match(home.text, /content="\/m\/docuseal\/"/, "the app's own origin became the prefix");
  assert.equal(home.headers["set-cookie"], undefined, "the app's cookies never reach the browser");
  // the app signed in once, with the credentials the install kept, and saw none of Vyre's
  assert.equal(w.seen.sign.length, 1);
  const forwarded = w.seen.reqs.filter(r => r.url === "/");
  assert.ok(forwarded.length >= 1);
  for (const r of w.seen.reqs) { assert.ok(!r.cookie.includes("vyre") && !r.cookie.includes("secret"), "no Vyre cookie reached the app"); assert.equal(r.auth, ""); assert.deepEqual(r.vyre, []); }
  assert.equal(forwarded[forwarded.length - 1].cookie, "sess=authed", "the app's own session is the proxy's");
  // css and redirects and the shim
  const css = await w.web("GET", "/m/docuseal/packs/app.css");
  assert.match(css.text, /url\(\/m\/docuseal\/img\/x\.png\)/);
  const go = await w.web("GET", "/m/docuseal/go");
  assert.equal(go.status, 302);
  assert.equal(go.headers.location, "/m/docuseal/templates/1");
  const shim = await w.web("GET", "/m/docuseal/__vyre/shim.js");
  assert.equal(shim.status, 200);
  assert.match(shim.headers["content-type"], /javascript/);
  assert.equal((await w.web("GET", "/m/docuseal/__vyre/shim.js", { caller: "mcp" })).status, 404);
  // a write carries the app's origin (its own anti-forgery check), not Vyre's
  const save = await w.web("POST", "/m/docuseal/save", { headers: { "content-type": "application/json", origin: "https://box.example", "content-length": "7" }, body: '{"a":1}' });
  assert.equal(save.status, 200, save.text);
  assert.deepEqual(JSON.parse(save.text), { got: '{"a":1}' });
});
