// @ts-check
// The runtime on its own: a real store and real child processes, with the clock, the vault,
// projects and Memory stubbed, so every rule in the brief can be driven by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open } from "../store/index.js";
import { migrate } from "../store/index.js";
import { Runtime, MIGRATIONS, BACKOFF_MS } from "./runtime.js";
import { tempHome } from "../../test/helpers.js";

const HOME_FOLDERS = ["/work/harlow-legal", "/work/harlow-site"];

/** A runtime in a temp home. `vault` maps names to values; `now` is the clock, moved by hand. */
function setup(t, { vault = {} } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "watchers", MIGRATIONS);
  const dir = path.join(root, "watchers");
  fs.mkdirSync(dir);
  const clock = { now: new Date("2026-03-02T10:07:00").getTime() };
  const events = [], taught = [], fetched = [];
  const rt = new Runtime({
    db, dir, now: () => clock.now, log: () => {},
    emit: (type, payload) => events.push({ type, ...payload }),
    call: async tool => tool === "projects.list"
      ? { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: HOME_FOLDERS[0], workspaces: HOME_FOLDERS }] } }
      : { error: { code: "no_such_tool" } },
    fetch: async name => { fetched.push(name); if (!(name in vault)) throw new Error(`no vault item ${name}`); return vault[name]; },
    teach: async (kind, fact) => { taught.push({ kind, ...fact }); return true; },
  });
  t.after(() => rt.stop());
  /** Write a watcher folder. */
  const write = (name, code, spec = {}) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", schedule: "*/15 * * * *", ...spec }));
    fs.writeFileSync(path.join(dir, name, "watch.js"), code);
  };
  return { root, db, dir, rt, clock, events, taught, fetched, write };
}

/** A watcher that emits whatever items the test's JSON file holds, and returns a cursor. */
const FROM_FILE = `import fs from "node:fs";
export default async function watch({ since, emit, log }) {
  const { items, fail } = JSON.parse(fs.readFileSync(new URL("./feed.json", import.meta.url), "utf8"));
  log("since", since);
  if (fail) throw new Error(fail);
  for (const i of items) emit(i);
  return items.length ? "cursor-" + items.at(-1).id : undefined;
}`;
const feed = (dir, name, body) => fs.writeFileSync(path.join(dir, name, "feed.json"), JSON.stringify(body));

test("watchers: the dry run returns items and files nothing; create needs a dry run of exactly this code", async t => {
  const { rt, dir, write, db, events } = setup(t);
  write("harlow-invoices", FROM_FILE, { emits: "invoice.seen" });
  feed(dir, "harlow-invoices", { items: [{ id: "a1", title: "Invoice 1041", at: "2026-03-01T09:00:00Z" }, { id: 7, title: "Invoice 1042" }] });

  await assert.rejects(rt.create("harlow-invoices"), /not been dry-run/);
  const dry = await rt.test("harlow-invoices");
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.count, 2);
  assert.deepEqual(dry.items.map(i => i.id), ["a1", "7"]);
  assert.equal(dry.items[0].at, Date.parse("2026-03-01T09:00:00Z"));
  assert.equal(dry.every, "every 15 minutes");
  assert.ok(dry.logs.includes("since null"));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM watchers_items").get()?.n, 0, "a dry run filed something");
  assert.equal(rt.list().watchers[0].state, "draft");

  // An edit after the dry run means the user has not seen what would run.
  fs.appendFileSync(path.join(dir, "harlow-invoices", "watch.js"), "\n// changed\n");
  await assert.rejects(rt.create("harlow-invoices"), /changed since its last dry run/);
  assert.equal((await rt.test("harlow-invoices")).ok, true);
  const on = await rt.create("harlow-invoices");
  assert.equal(on.state, "on");
  await rt.settle();
  assert.ok(events.some(e => e.type === "watcher.created"));
});

test("watchers: runs on schedule, files each item once, teaches it scoped to the project, and passes the cursor on", async t => {
  const { rt, dir, write, clock, events, taught } = setup(t);
  write("harlow-invoices", FROM_FILE, { emits: "invoice.seen" });
  feed(dir, "harlow-invoices", { items: [{ id: "a1", title: "Invoice 1041", url: "https://billing.example/1041" }] });
  await rt.test("harlow-invoices");
  await rt.create("harlow-invoices");
  await rt.settle();                               // create runs it once straight away

  assert.deepEqual(rt.items({ project: "harlow-legal" }).map(i => [i.id, i.kind, i.watcher]), [["a1", "invoice.seen", "harlow-invoices"]]);
  assert.equal(taught.length, 1);
  assert.deepEqual(taught[0], { kind: "watcher.item", subject: { name: "harlow-invoices" }, text: "Invoice 1041 · https://billing.example/1041",
    at: undefined, key: "harlow-invoices/a1", project_cwds: HOME_FOLDERS });
  let w = rt.list().watchers[0];
  assert.equal(w.state, "on");
  assert.equal(new Date(/** @type {string} */ (w.next)).getMinutes(), 15);

  // Not yet due: nothing runs.
  clock.now = new Date("2026-03-02T10:14:00").getTime();
  assert.equal(rt.tick().length, 0);

  // Due: the repeat is not filed again, the new item is, and the cursor from last time arrives.
  feed(dir, "harlow-invoices", { items: [{ id: "a1", title: "Invoice 1041" }, { id: "a2", title: "Invoice 1042", about: "Northwind Bakery" }] });
  clock.now = new Date("2026-03-02T10:15:00").getTime();
  assert.equal(rt.tick().length, 1);
  await rt.settle();
  assert.deepEqual(rt.items({ name: "harlow-invoices" }).map(i => i.id).sort(), ["a1", "a2"]);
  assert.equal(taught.length, 2);
  assert.deepEqual(taught[1].subject, { name: "Northwind Bakery" }, "an item's about names what it is about");
  const fired = events.filter(e => e.type === "watcher.fired");
  assert.deepEqual(fired.at(-1), { type: "watcher.fired", name: "harlow-invoices", items: 1, seen: 2, trigger: "schedule" });
  assert.ok(rt.logs("harlow-invoices")[0].logs.includes("since cursor-a1"));
  w = rt.list().watchers[0];
  assert.equal(w.items, 2);
});

test("watchers: a failure retries with backoff, and three in a row pause it with watcher.failed", async t => {
  const { rt, dir, write, clock, events } = setup(t);
  write("harlow-invoices", FROM_FILE);
  feed(dir, "harlow-invoices", { items: [] });
  await rt.test("harlow-invoices");
  await rt.create("harlow-invoices");
  await rt.settle();
  const before = rt.row("harlow-invoices").since;

  feed(dir, "harlow-invoices", { items: [], fail: "billing answered 503" });
  clock.now = new Date("2026-03-02T10:15:00").getTime();
  rt.tick(); await rt.settle();
  let r = rt.row("harlow-invoices");
  assert.equal(r.failures, 1);
  assert.equal(r.next_at, clock.now + BACKOFF_MS[0]);
  assert.equal(r.since, before, "a failed run must not move the cursor");

  clock.now += BACKOFF_MS[0];
  rt.tick(); await rt.settle();
  r = rt.row("harlow-invoices");
  assert.equal(r.failures, 2);
  assert.equal(r.next_at, clock.now + BACKOFF_MS[1]);
  assert.equal(rt.logs("harlow-invoices")[0].trigger, "retry");

  clock.now += BACKOFF_MS[1];
  rt.tick(); await rt.settle();
  r = rt.row("harlow-invoices");
  assert.equal(r.paused, 1);
  assert.match(r.paused_why, /failed 3 times in a row: billing answered 503/);
  assert.deepEqual(events.filter(e => e.type === "watcher.failed").map(e => [e.failures, e.paused]), [[1, false], [2, false], [3, true]]);
  assert.ok(events.some(e => e.type === "watcher.paused"));
  clock.now += 3_600_000;
  assert.equal(rt.tick().length, 0, "a paused watcher ran");

  // Resume clears the count; a success resets it too.
  feed(dir, "harlow-invoices", { items: [{ id: "b1" }] });
  rt.resume("harlow-invoices");
  assert.equal(rt.row("harlow-invoices").failures, 0);
  clock.now = rt.row("harlow-invoices").next_at;
  rt.tick(); await rt.settle();
  assert.equal(rt.row("harlow-invoices").last_error, null);
});

test("watchers: editing a watcher after it is turned on pauses it until it is dry-run and created again", async t => {
  const { rt, dir, write, clock } = setup(t);
  write("harlow-invoices", FROM_FILE);
  feed(dir, "harlow-invoices", { items: [{ id: "a1" }] });
  await rt.test("harlow-invoices");
  await rt.create("harlow-invoices");
  await rt.settle();
  // Widening needs is exactly what must not slip through unseen.
  write("harlow-invoices", FROM_FILE, { needs: ["billing-inbox"] });
  assert.equal(rt.list().watchers[0].state, "changed");
  clock.now = new Date("2026-03-02T10:15:00").getTime();
  rt.tick(); await rt.settle();
  assert.match(rt.row("harlow-invoices").paused_why, /changed since it was turned on/);
  assert.throws(() => rt.resume("harlow-invoices"), /changed since it was turned on/);
  assert.equal((await rt.test("harlow-invoices")).ok, true);
  await rt.create("harlow-invoices");
  await rt.settle();
  assert.equal(rt.list().watchers[0].state, "on");
  assert.equal(JSON.parse(rt.row("harlow-invoices").since), "cursor-a1", "turning on again keeps the cursor");
});

test("watchers: bad items fail the dry run with what to fix", async t => {
  const { rt, write } = setup(t);
  write("no-id", `export default async function watch({ emit }) { emit({ title: "x" }); }`);
  assert.match((await rt.test("no-id")).error, /item 1 has no id/);
  write("too-big", `export default async function watch({ emit }) { emit({ id: 1, body: "x".repeat(9000) }); }`);
  assert.match((await rt.test("too-big")).error, /at most 4000.*Link to the document/);
  write("throws", `export default async function watch() { throw new Error("feed answered 404"); }`);
  assert.equal((await rt.test("throws")).error, "feed answered 404");
  write("bad-spec", `export default async function watch() {}`, { schedule: "every hour", token: "x" });
  const r = await rt.test("bad-spec");
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /five fields/.test(p)));
  assert.ok(r.problems.some(p => /keys the runtime does not read: token/.test(p)));
});

test("watchers: vault items only from the watcher's own needs, and a released value never reaches a log or an item", async t => {
  const secret = "billing-value-0000111122223333";
  const { rt, write, fetched } = setup(t, { vault: { "billing-inbox": secret, "other-item": "nope" } });
  write("harlow-invoices", `export default async function watch({ vault, emit, log }) {
    const v = await vault.fetch("billing-inbox");
    log("got", v);
    console.log("token is " + v);
    try { await vault.fetch("other-item"); } catch (e) { log("refused:", e.message); }
    emit({ id: "a1", title: "ok" });
  }`, { needs: ["billing-inbox"] });
  const r = await rt.test("harlow-invoices");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(fetched, ["billing-inbox"], "the runtime asked the vault for an item the watcher does not list");
  const all = JSON.stringify(r) + JSON.stringify(rt.logs("harlow-invoices"));
  assert.ok(!all.includes(secret), "a vault value reached a log");
  assert.ok(r.logs.some(l => l === "got [vault value]"));
  assert.ok(r.logs.some(l => /refused: this watcher does not list "other-item"/.test(l)));

  write("leaky", `export default async function watch({ vault, emit }) { emit({ id: 1, title: await vault.fetch("billing-inbox") }); }`, { needs: ["billing-inbox"] });
  const leak = await rt.test("leaky");
  assert.match(leak.error, /carried a value from the vault/);
  assert.ok(!JSON.stringify(leak).includes(secret));
});

test("watchers: each run is a child with no environment that can read only its own folder and write nothing", async t => {
  const { rt, write, root } = setup(t);
  fs.writeFileSync(path.join(root, "config.json"), "{}");
  process.env.VYRE_WATCHER_TEST = "inherited";
  t.after(() => { delete process.env.VYRE_WATCHER_TEST; });
  write("probe", `import fs from "node:fs";
  import cp from "node:child_process";
  export default async function watch({ emit }) {
    const tryIt = f => { try { f(); return "allowed"; } catch (e) { return e.code || e.message; } };
    emit({ id: "own", title: tryIt(() => fs.readFileSync(new URL("./watcher.json", import.meta.url))) });
    emit({ id: "other", title: tryIt(() => fs.readFileSync(${JSON.stringify(path.join(root, "config.json"))})) });
    emit({ id: "write", title: tryIt(() => fs.writeFileSync(new URL("./x", import.meta.url), "1")) });
    emit({ id: "spawn", title: tryIt(() => cp.execSync("true")) });
    emit({ id: "env", title: process.env.VYRE_WATCHER_TEST || "none" });
  }`);
  const r = await rt.test("probe");
  assert.equal(r.ok, true, JSON.stringify(r));
  const by = Object.fromEntries(r.items.map(i => [i.id, i.title]));
  assert.equal(by.own, "allowed");
  assert.equal(by.other, "ERR_ACCESS_DENIED");
  assert.equal(by.write, "ERR_ACCESS_DENIED");
  assert.equal(by.spawn, "ERR_ACCESS_DENIED");
  assert.equal(by.env, "none");
});

test("watchers: a run that hangs is stopped at its timeout", async t => {
  const { rt, write } = setup(t);
  write("slow", `export default async function watch() { await new Promise(r => setTimeout(r, 60_000)); }`, { timeout: 1 });
  const r = await rt.test("slow");
  assert.match(r.error, /took longer than 1s/);
});

test("watchers: the network is reachable, and a webhook watcher gets the body and checks its token", async t => {
  const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: 11, title: "SQLite 4.0 released" }])); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const port = /** @type {any} */ (server.address()).port;
  const { rt, write } = setup(t);
  write("feed", `export default async function watch({ emit }) {
    const res = await fetch("http://127.0.0.1:${port}/");
    for (const s of await res.json()) emit(s);
  }`);
  assert.deepEqual((await rt.test("feed")).items.map(i => i.title), ["SQLite 4.0 released"]);

  write("harlow-forms", `export default async function watch({ hook, emit }) { if (hook) emit({ id: hook.submission, title: hook.subject }); }`, { schedule: "webhook" });
  await rt.test("harlow-forms");
  const on = await rt.create("harlow-forms");
  await rt.settle();
  assert.equal(on.hook.path, "/v1/watchers/harlow-forms/hook");
  assert.ok(on.hook.token.length >= 30);
  await assert.rejects(rt.hook("harlow-forms", "wrong", {}), /wrong token/);
  await rt.hook("harlow-forms", on.hook.token, { submission: "s-9", subject: "New intake form" });
  await rt.settle();
  assert.deepEqual(rt.items({ name: "harlow-forms" }).map(i => i.title), ["New intake form"]);
  // Calls that arrive during a run are queued, not dropped: each body is an item.
  await Promise.all(["s-10", "s-11", "s-12"].map(id => rt.hook("harlow-forms", on.hook.token, { submission: id, subject: id })));
  await rt.settle();
  assert.equal(rt.items({ name: "harlow-forms" }).length, 4);
  assert.equal(rt.tick().length, 0, "a webhook watcher has no schedule to run on");
  assert.ok(!JSON.stringify(rt.list()).includes(on.hook.token), "the list shows the webhook token");
});
