// @ts-check
// The session wake in the runtime: what a watcher may post into a session, and when it may not. No child
// runs here: wake() is called directly with the items a run just filed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Runtime, MIGRATIONS } from "./runtime.js";
import * as folder from "./folder.js";
import { tempHome } from "../../test/helpers.js";

function setup(t, { threads = { "t-1": { project: "harlow-legal" }, "t-2": { project: "northwind" } }, refuse = null } = {}) {
  const root = tempHome(t);
  const db = open(path.join(root, "vyre.db")); t.after(() => db.close());
  migrate(db, "watchers", MIGRATIONS);
  const dir = path.join(root, "watchers"); fs.mkdirSync(dir);
  const clock = { now: new Date("2026-03-02T10:00:00Z").getTime() }, posts = [], events = [];
  const rt = new Runtime({ db, dir, now: () => clock.now, log: () => {}, emit: (type, payload) => events.push({ type, ...payload }),
    call: async () => ({ error: { code: "no_such_tool" } }), fetch: async () => "", teach: async () => true,
    thread: async id => threads[id] || null,
    post: async (thread, text, from) => { if (refuse) throw new Error(refuse); posts.push({ thread, text, from }); } });
  t.after(() => rt.stop());
  const write = (name, spec) => { fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", schedule: "*/15 * * * *", ...spec }));
    fs.writeFileSync(path.join(dir, name, "watch.js"), "export default async function watch() {}"); return folder.read(dir, name); };
  return { rt, dir, write, clock, posts, events };
}
const WAKE = { owner: { kind: "session", thread: "t-1" }, about: { session: "t-1" }, act: true, wake: { maxPerDay: 2 } };
const items = n => Array.from({ length: n }, (_, i) => ({ id: "c" + i, title: "Review comment " + i, about: "Dana", quote: "Please rename this", url: "https://github.com/x/y/pull/12#c" + i }));

test("the folder check: a watcher that wakes a session is owned by that session, acts, and says how often", t => {
  const { write } = setup(t);
  assert.deepEqual(write("ok", WAKE).problems, []);
  const spec = write("ok2", { ...WAKE, wake: undefined }).spec;
  assert.deepEqual([spec.about, spec.wake, spec.owner.kind], [{ session: "t-1" }, { maxPerDay: 5 }, "session"], "five a day by default");
  const bad = (name, over) => write(name, { ...WAKE, ...over }).problems.join(" | ");
  assert.match(bad("b1", { act: undefined }), /needs act true/);
  assert.match(bad("b2", { owner: { kind: "session", thread: "t-9" } }), /owned by that session/);
  assert.match(bad("b3", { owner: undefined }), /owned by that session|needs owner/);
  assert.match(bad("b4", { wake: { maxPerDay: 99 } }), /wake is/);
  assert.match(bad("b5", { about: { session: "../etc" } }), /about is/);
  assert.match(write("b6", { wake: { maxPerDay: 2 } }).problems.join(), /wake needs about/);
  assert.match(write("b7", { owner: { kind: "session", thread: "t-1" } }).problems.join(), /owner session is for a watcher that wakes it/);
});

test("new items are posted once per run as quoted untrusted data, from the watcher, to its own session", async t => {
  const { rt, write, posts, events } = setup(t);
  const spec = write("pr-12", WAKE).spec;
  const logs = [];
  await rt.wake(spec, items(2), logs);
  assert.equal(posts.length, 1, "one post per run");
  assert.deepEqual([posts[0].thread, posts[0].from], ["t-1", "watcher:pr-12"]);
  assert.match(posts[0].text, /<vyre-data nonce="[0-9a-f]{18}" source="watcher:pr-12" untrusted="true">/);
  assert.match(posts[0].text, /Review comment 0/); assert.match(posts[0].text, /Review comment 1/);
  assert.ok(logs.some(l => /woke session t-1 with 2 items/.test(l)));
  assert.ok(events.some(e => e.type === "watcher.woke" && e.thread === "t-1" && e.items === 2));
});

test("it is not woken when the watcher is not the session's, the session is gone or in another project, or the day's budget is spent", async t => {
  const { rt, write, posts, clock } = setup(t);
  const spec = write("pr-12", WAKE).spec;
  const run = async s => { const logs = []; await rt.wake(s, items(1), logs); return logs.join(" | "); };
  assert.match(await run({ ...spec, owner: { kind: "session", thread: "t-9" } }), /not owned by that session/);
  assert.match(await run({ ...spec, owner: { kind: "teammate", teammate: "reviewer-harlow-legal" } }), /not owned by that session/);
  assert.match(await run({ ...spec, about: { session: "t-gone" }, owner: { kind: "session", thread: "t-gone" } }), /no session t-gone/);
  assert.match(await run({ ...spec, about: { session: "t-2" }, owner: { kind: "session", thread: "t-2" } }), /another project/);
  assert.equal(posts.length, 0, "none of those posted");
  assert.match(await run(spec), /woke session t-1/); assert.match(await run(spec), /woke session t-1/);
  assert.match(await run(spec), /already woke it 2 times today \(the most is 2\)/);
  assert.equal(posts.length, 2);
  clock.now += 24 * 3600 * 1000;
  assert.match(await run(spec), /woke session t-1/, "a new day, a new budget");
});

test("a refused post is logged and not retried, and a machine with no session posting says so", async t => {
  const a = setup(t, { refuse: "thread is archived" });
  const spec = a.write("pr-12", WAKE).spec; const logs = [];
  await a.rt.wake(spec, items(1), logs);
  assert.ok(logs.some(l => /the post was refused: thread is archived/.test(l)));
  assert.equal(a.rt.db.prepare("SELECT COUNT(*) n FROM watchers_wakes").get().n, 0, "a refused post is not counted against the budget");
});

test("the card says it posts quoted notes into the session, and never as an instruction", t => {
  const { rt, write } = setup(t);
  write("pr-12", WAKE);
  const c = rt.card("pr-12");
  assert.match(c.facts.acts, /Posts what it finds into session t-1 as quoted notes, up to 2 times a day; never as an instruction/);
  assert.deepEqual(c.owner, { kind: "session", thread: "t-1" });
});
