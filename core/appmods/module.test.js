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
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { seam, handleWebhook, pick } from "./index.js";

const docuseal = () => JSON.parse(fs.readFileSync(new URL("./catalog/docuseal.json", import.meta.url), "utf8"));

async function world(t) {
  const PDF = Buffer.from("%PDF-1.4 signed bytes");
  const app = http.createServer((q, r) => { if (q.url === "/file/abc/nda.pdf") r.writeHead(200, { "content-type": "application/pdf" }).end(PDF); else r.writeHead(302, { location: "/sign_in" }).end(); });
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
  return { d, root, cli, log, lines, boot: () => boot, model: (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" }) };
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
