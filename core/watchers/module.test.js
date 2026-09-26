// @ts-check
// The watchers module inside a real vyred, with the real vault on a file keystore,
// real projects and Memory, a watcher that reads a local feed, and the webhook route.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { request, call } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, writeModule, present } from "../../test/helpers.js";

async function boot(t, { vault = true } = {}) {
  const root = tempHome(t);
  const p = config.ensure(root);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // The real vault, on a file keystore so no test touches a keychain; or none at all.
  fs.writeFileSync(p.config, JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")],
    ...(vault ? { vault: { keystore: "file" } } : { modules: { disable: ["vault"] } }) }));

  // A feed that wants the key, the way a real API would.
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer feed-key-value-9f8e7d6c5b4a") { res.statusCode = 401; return res.end("{}"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify([{ id: 101, title: "SQLite 4.0 released", url: "https://news.example/101" }, { id: 102, title: "A bakery's Postgres migration" }]));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const port = /** @type {any} */ (server.address()).port;

  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const made = await call("projects.create", { name: "Harlow Legal", home }, { root });
  assert.ok(!made.error, JSON.stringify(made.error));
  if (vault) {
    const put = await call("vault.put", { name: "feed-key", value: "feed-key-value-9f8e7d6c5b4a" }, { root, caller: "cli" });
    assert.ok(!put.error, JSON.stringify(put.error));
  }
  return { root, p, home, port, d };
}

function writeWatcher(p, name, spec, code) {
  const dir = path.join(p.watchers, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", ...spec }));
  fs.writeFileSync(path.join(dir, "watch.js"), code);
}

test("watchers module: dry run, create, filing into the project, and the items in memory.facts for its folders", async t => {
  const { root, p, home, port } = await boot(t);
  writeWatcher(p, "harlow-sqlite", { schedule: "*/15 * * * *", needs: ["feed-key"], emits: "post.seen" }, `
    export default async function watch({ vault, emit }) {
      const res = await fetch("http://127.0.0.1:${port}/", { headers: { authorization: "Bearer " + await vault.fetch("feed-key") } });
      if (!res.ok) throw new Error("feed answered " + res.status);
      for (const s of await res.json()) if (/sqlite/i.test(s.title)) emit({ id: s.id, title: s.title, url: s.url });
    }`);
  const grant = await call("vault.grant", { name: "feed-key", module: "watchers", watcher: "harlow-sqlite" }, { root, caller: "cli" });
  assert.ok(!grant.error, JSON.stringify(grant.error));

  const listed = (await call("watchers.list", {}, { root })).data;
  assert.equal(listed.dir, p.watchers);
  assert.equal(listed.watchers[0].state, "draft");

  const dry = (await call("watchers.test", { name: "harlow-sqlite" }, { root })).data;
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.deepEqual(dry.items.map(i => i.title), ["SQLite 4.0 released"]);
  assert.equal((await call("watchers.items", { name: "harlow-sqlite" }, { root })).data.length, 0);

  const on = await call("watchers.create", { name: "harlow-sqlite" }, { root });
  assert.ok(!on.error, JSON.stringify(on.error));
  // Created runs once at once; wait for its filing and Memory's pass.
  let items = [];
  for (let i = 0; i < 50 && !items.length; i++) { await new Promise(r => setTimeout(r, 100)); items = (await call("watchers.items", { project: "harlow-legal" }, { root })).data; }
  assert.deepEqual(items.map(i => [i.id, i.kind]), [["101", "post.seen"]]);

  await call("memory.curate", {}, { root });
  const facts = (await call("memory.facts", { project_cwds: [home] }, { root })).data.facts;
  assert.ok(facts.some(f => /SQLite 4\.0 released/.test(f.text) && f.taught?.some(x => x.module === "watchers")), JSON.stringify(facts));
  // Another project's view does not see it.
  const elsewhere = (await call("memory.facts", { project_cwds: [path.join(path.dirname(home), "northwind-bakery")] }, { root })).data.facts;
  assert.ok(!elsewhere.some(f => /SQLite/.test(f.text)));

  const ev = (await request("GET", "/v1/events?type=watcher.fired", undefined, { root })).data;
  assert.equal(ev.at(-1).payload.items, 1);
  assert.equal(ev.at(-1).project, "harlow-legal");
  const all = JSON.stringify((await request("GET", "/v1/events?limit=1000", undefined, { root })).data) + JSON.stringify((await call("watchers.logs", { name: "harlow-sqlite" }, { root })).data);
  assert.ok(!all.includes("feed-key-value"), "a vault value reached an event or a log");
});

test("watchers module: the webhook route checks the token, and the hook tool is never listed or callable as a tool", async t => {
  const { root, p } = await boot(t);
  writeWatcher(p, "harlow-forms", { schedule: "webhook" }, `export default async function watch({ hook, emit }) { if (hook) emit({ id: hook.id, title: hook.title }); }`);
  assert.equal((await call("watchers.test", { name: "harlow-forms" }, { root })).data.ok, true);
  const on = (await call("watchers.create", { name: "harlow-forms" }, { root })).data;

  const tools = (await request("GET", "/v1/tools", undefined, { root })).data.map(x => x.name);
  assert.ok(tools.includes("watchers.create") && !tools.includes("watchers.hook"));
  assert.equal((await call("watchers.hook", { name: "harlow-forms", token: on.hook.token }, { root })).error.code, "no_such_tool");

  const bad = await request("POST", "/v1/watchers/harlow-forms/hook?token=wrong", { id: 1 }, { root });
  assert.match(bad.error.message, /wrong token/);
  const ok = await request("POST", `/v1/watchers/harlow-forms/hook?token=${on.hook.token}`, { id: "f-1", title: "New intake form" }, { root });
  assert.deepEqual(ok.data, { accepted: true });
  let items = [];
  for (let i = 0; i < 50 && !items.length; i++) { await new Promise(r => setTimeout(r, 100)); items = (await call("watchers.items", { name: "harlow-forms" }, { root })).data; }
  assert.deepEqual(items.map(i => i.title), ["New intake form"]);
});

test("watchers module: without a vault, a watcher that needs one fails its run and says why", async t => {
  const root = tempHome(t);
  const p = config.ensure(root);
  fs.writeFileSync(p.config, JSON.stringify({ transcripts: [path.join(root, "none")], modules: { disable: ["vault"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  writeWatcher(p, "harlow-inbox", { schedule: "@hourly", needs: ["billing-inbox"] }, `export default async function watch({ vault }) { await vault.fetch("billing-inbox"); }`);
  const r = (await call("watchers.test", { name: "harlow-inbox" }, { root })).data;
  assert.equal(r.ok, false);
  assert.match(r.error, /the vault is not running on this machine/);
});
