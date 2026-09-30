// @ts-check
// The context module against fake projects and sight modules in a temp home. Nothing here reads
// a real screen or a real project: every answer comes from a fake written into the home.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { stripUrl, clean } from "./index.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const INTERVAL = 60;
const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

// projects.of answers for folders under /work/harlow and /work/northwind, counts its calls, and
// has a tool that emits project.changed so a test can invalidate the cache.
const PROJECTS = `export let calls = 0;
export default { async start(ctx) {
  ctx.tool("projects.of", { input: { type: "object", required: ["cwd"], properties: { cwd: { type: "string" } } }, run: async ({ cwd }) => {
    calls++; globalThis.__projectsOfCalls = calls;
    const map = globalThis.__projectsMap || { "/work/harlow": "harlow-legal", "/work/northwind": "northwind-bakery" };
    const hit = Object.keys(map).find(f => cwd === f || cwd.startsWith(f + "/"));
    return hit ? { slug: map[hit], name: map[hit], home: hit, folders: [hit] } : null;
  } });
  ctx.tool("projects.poke", { run: async () => { ctx.events.emit("project.changed", { project: "harlow-legal", fields: ["folders"] }); return {}; } });
  return {};
} };`;

const SIGHT = `export default { async start(ctx) {
  ctx.tool("sight.now", { run: async input => ({ target: input.target, kind: "mac", app: "Safari", window: "Northwind Bakery", url: "https://northwind.example/menu",
    step: null, at: 1, asked: input.parts, text: "fake visible text" }) });
  return {};
} };`;

async function world(t, { projects = true, sight = false } = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  if (projects) writeModule(root, "projects", { roles: ["box", "local"], does: { tools: ["projects.of", "projects.poke"] }, watches: { emits: ["project.changed"] } }, PROJECTS);
  if (sight) writeModule(root, "sight", { roles: ["box", "local"], does: { tools: ["sight.now"] }, watches: { emits: [] } }, SIGHT);
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local", context: { intervalMs: INTERVAL } }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "context");
  await reg.start([...core, ...discover([root])], { role: "local" });
  /** @type {any[]} */
  const seen = [];
  events.on("context.changed", e => seen.push(e));
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await reg.stop?.(); } };
  t.after(async () => { await stop(); db.close(); });
  const call = async (/** @type {string} */ tool, input = {}, caller = "cli", meta = {}) => reg.call(tool, input, caller, meta);
  return { reg, call, seen, stop };
}

test("stripUrl: no query, fragment or credentials; a non-URL is cut at ? or #", () => {
  assert.equal(stripUrl("https://alex:pw@harlow.example/case/12?token=abc&x=1#notes"), "https://harlow.example/case/12");
  assert.equal(stripUrl("not a url?q=1#h"), "not a url");
  assert.equal(stripUrl("about:blank"), "about:blank");
});

test("clean: refuses text, selection and value, and a bad surface or cwd", () => {
  for (const k of ["text", "selection", "value", "selected", "focused"])
    assert.throws(() => clean({ surface: "capsule", [k]: "secret words" }), (/** @type {any} */ e) => e.code === "bad_input", k);
  assert.throws(() => clean({ surface: "Capsule!" }), /surface/);
  assert.throws(() => clean({ surface: "chat", cwd: "relative/dir" }), /absolute/);
  assert.deepEqual(clean({ surface: "chat", thread: "  t-1 ", app: "", other: "ignored" }).fields, { thread: "t-1", app: null });
});

test("report and now: fields merge per surface, the newest value of each field wins across surfaces", async t => {
  const { call } = await world(t);
  assert.deepEqual((await call("context.now")).data, { project: null, cwd: null, thread: null, view: null, surface: null, device: null, app: null, window: null, url: null, tz: null, localTime: null, day: null, at: null, surfaces: [] });

  const r1 = await call("context.report", { surface: "capsule", device: "alex-mac", app: "Safari", window: "Menu", url: "https://northwind.example/menu?session=abc#top" }, "capsule");
  assert.deepEqual(r1.data.changed.sort(), ["app", "url", "window"]);
  await wait(5);
  await call("context.report", { surface: "chat", thread: "t-juno-1", project: "harlow-legal" }, "deck");
  await wait(5);
  // The Capsule reports again with only the app: its window and url stay, and it is the focus again.
  await call("context.report", { surface: "capsule", device: "alex-mac", app: "Terminal" }, "capsule");

  const now = (await call("context.now")).data;
  assert.equal(now.app, "Terminal");
  assert.equal(now.window, "Menu");
  assert.equal(now.url, "https://northwind.example/menu");
  assert.equal(now.thread, "t-juno-1");
  assert.equal(now.project, "harlow-legal");
  assert.equal(now.surface, "capsule");
  assert.equal(now.device, "alex-mac");
  assert.deepEqual(now.surfaces.map((/** @type {any} */ s) => s.surface), ["capsule", "chat"]);
  assert.equal(now.at, now.surfaces[0].at);

  // null clears a field for that surface.
  await call("context.report", { surface: "capsule", device: "alex-mac", url: null }, "capsule");
  assert.equal((await call("context.now")).data.url, null);
  // Same values again change nothing.
  assert.deepEqual((await call("context.report", { surface: "capsule", device: "alex-mac", app: "Terminal" }, "capsule")).data.changed, []);
});

test("tz, localTime and day: the reporting device's own clock, never the server's, newest device wins", async t => {
  const { call } = await world(t);
  assert.equal((await call("context.now")).data.tz, null);
  assert.equal((await call("context.now")).data.day, null);

  await call("context.report", { surface: "phone", device: "alex-phone", tz: "America/Los_Angeles", localTime: "2026-09-28T07:15:00-07:00" }, "tailnet:alex");
  let now = (await call("context.now")).data;
  assert.equal(now.tz, "America/Los_Angeles");
  assert.equal(now.localTime, "2026-09-28T07:15:00-07:00");
  assert.equal(now.day, "2026-09-28");

  // A second device reports later: its clock wins, not the first device's, and not the server's.
  await wait(5);
  await call("context.report", { surface: "capsule", device: "alex-mac", tz: "Asia/Karachi", localTime: "2026-09-28T20:16:00+05:00" }, "capsule");
  now = (await call("context.now")).data;
  assert.equal(now.tz, "Asia/Karachi");
  assert.equal(now.day, "2026-09-28");

  // null clears it for that device; like every other field, the newest report wins even when it
  // is a clear, so the answer goes null rather than falling back to an older device's value.
  await call("context.report", { surface: "capsule", device: "alex-mac", tz: null, localTime: null }, "capsule");
  now = (await call("context.now")).data;
  assert.equal(now.tz, null);
  assert.equal(now.day, null);
});

test("clean: refuses a tz or localTime that is not the device's own clock format", () => {
  assert.throws(() => clean({ surface: "phone", tz: "not a zone!" }), /tz must be an IANA zone/);
  assert.throws(() => clean({ surface: "phone", localTime: "2026-09-28 07:15" }), /localTime must be an ISO 8601/);
  assert.throws(() => clean({ surface: "phone", localTime: "2026-09-28T07:15:00" }), /offset/, "no bare timestamp with no offset");
  assert.deepEqual(clean({ surface: "phone", tz: "UTC", localTime: "2026-09-28T07:15:00Z" }).fields, { tz: "UTC", localTime: "2026-09-28T07:15:00Z" });
});

test("report: screen text and selection are refused with bad_input, and nothing is stored", async t => {
  const { call } = await world(t);
  const r = await call("context.report", { surface: "capsule", app: "Mail", text: "Dear Harlow Legal", selection: "Harlow" }, "capsule");
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /text, selection/);
  assert.equal((await call("context.now")).data.app, null);
  assert.equal((await call("context.report", {}, "capsule")).error.code, "bad_input");
});

test("project: found from the folder through projects.of, cached per folder, forgotten on project.changed", async t => {
  const { call } = await world(t);
  await call("context.report", { surface: "cli", cwd: "/work/harlow/site" });
  assert.equal((await call("context.now")).data.project, "harlow-legal");
  await wait(INTERVAL + 20); // let the event's own lookup settle
  const before = /** @type {any} */ (globalThis).__projectsOfCalls;
  await call("context.now");
  await call("context.now");
  assert.equal(/** @type {any} */ (globalThis).__projectsOfCalls, before, "the second and third answers came from the cache");

  // A reported project older than the folder gives way to the folder's project.
  await call("context.report", { surface: "chat", project: "northwind-bakery" }, "deck");
  assert.equal((await call("context.now")).data.project, "northwind-bakery");
  await wait(5);
  await call("context.report", { surface: "cli", cwd: "/work/harlow" });
  assert.equal((await call("context.now")).data.project, "harlow-legal");
  // A folder no project owns leaves the reported project in place.
  await wait(5);
  await call("context.report", { surface: "cli", cwd: "/tmp/scratch" });
  assert.equal((await call("context.now")).data.project, "northwind-bakery");

  // The folder moves to another project; after project.changed the next answer asks again.
  await call("context.report", { surface: "cli", cwd: "/work/harlow" });
  assert.equal((await call("context.now")).data.project, "harlow-legal");
  /** @type {any} */ (globalThis).__projectsMap = { "/work/harlow": "harlow-legal-2026" };
  t.after(() => { delete (/** @type {any} */ (globalThis).__projectsMap); });
  assert.equal((await call("context.now")).data.project, "harlow-legal", "still cached");
  await call("projects.poke");
  assert.equal((await call("context.now")).data.project, "harlow-legal-2026");
});

test("project: without a projects module the folder is kept and the project stays null", async t => {
  const { call } = await world(t, { projects: false });
  await call("context.report", { surface: "cli", cwd: "/work/harlow" });
  const now = (await call("context.now")).data;
  assert.equal(now.cwd, "/work/harlow");
  assert.equal(now.project, null);
});

test("context.changed: first change at once, later ones in the window folded into one, never app, window or url", async t => {
  const { call, seen } = await world(t);
  await call("context.report", { surface: "capsule", device: "alex-mac", app: "Safari", url: "https://harlow.example/?q=1" }, "capsule");
  await wait(15);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, { changed: ["app", "url"], surface: "capsule", device: "alex-mac" });

  // Three reports inside the window become one trailing event.
  await call("context.report", { surface: "capsule", device: "alex-mac", app: "Terminal" }, "capsule");
  await call("context.report", { surface: "capsule", device: "alex-mac", window: "kit: build" }, "capsule");
  await call("context.report", { surface: "capsule", device: "alex-mac", cwd: "/work/northwind/app", thread: "t-kit-7" }, "capsule");
  await wait(10);
  assert.equal(seen.length, 1, "nothing more inside the window");
  await wait(INTERVAL + 30);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].payload, { changed: ["app", "cwd", "project", "thread", "window"], surface: "capsule", device: "alex-mac", project: "northwind-bakery", thread: "t-kit-7" });
  assert.equal(seen[1].project, "northwind-bakery");
  assert.equal(seen[1].thread, "t-kit-7");
  assert.ok(seen[1].at - seen[0].at >= INTERVAL - 5, "at most one per window");

  // A report that changes nothing emits nothing.
  await wait(INTERVAL + 10);
  await call("context.report", { surface: "capsule", device: "alex-mac", app: "Terminal" }, "capsule");
  await wait(INTERVAL + 30);
  assert.equal(seen.length, 2);

  // Another surface has its own window.
  await call("context.report", { surface: "phone", device: "alex-phone", thread: "t-juno-2" }, "tailnet:alex");
  await wait(15);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2].payload, { changed: ["thread"], surface: "phone", device: "alex-phone", thread: "t-juno-2" });

  for (const e of seen) {
    const json = JSON.stringify(e.payload);
    for (const no of ["Safari", "Terminal", "harlow.example", "kit: build"]) assert.ok(!json.includes(no), `${no} in ${json}`);
    for (const k of ["app", "window", "url"]) assert.ok(!(k in e.payload), k);
  }
});

test("screen part: from sight on this Mac, refused over the tailnet, and absent without sight", async t => {
  const { call } = await world(t, { sight: true });
  const local = (await call("context.now", { parts: ["screen"] }, "capsule")).data;
  assert.equal(local.screen.target, "mac");
  assert.deepEqual(local.screen.asked, ["text"]);
  assert.equal(local.screen_why, undefined);

  for (const [caller, meta] of [["tailnet:alex", {}], ["cli", { peer: { node: "alex-phone" } }]]) {
    const r = (await call("context.now", { parts: ["screen"] }, /** @type {string} */ (caller), meta)).data;
    assert.equal(r.screen, null, String(caller));
    assert.equal(r.screen_why, "local_only");
    assert.ok(!JSON.stringify(r).includes("fake visible text"));
  }
  assert.equal((await call("context.now", {}, "capsule")).data.screen, undefined, "no screen unless asked");

  const bare = await world(t, { sight: false });
  const r = (await bare.call("context.now", { parts: ["screen"] }, "capsule")).data;
  assert.equal(r.screen, null);
  assert.equal(r.screen_why, "no_sight");
});

test("stop: a pending trailing event is dropped and no timer keeps the process alive", async t => {
  const { call, seen, stop } = await world(t);
  await call("context.report", { surface: "chat", thread: "t-1" }, "deck");
  await wait(10);
  await call("context.report", { surface: "chat", thread: "t-2" }, "deck");
  const before = seen.length;
  await stop();
  await wait(INTERVAL + 30);
  assert.equal(seen.length, before, "the trailing event never came");
});

test("report: a device paired through the relay is named by its caller when the report leaves it out", async t => {
  const { call } = await world(t);
  const id = "abcdefghijklmnop";
  const r = await call("context.report", { surface: "phone", thread: "t1" }, `device:${id}`);
  assert.equal(r.data.device, id);
  assert.equal((await call("context.now")).data.device, id);
  const said = await call("context.report", { surface: "phone", device: "alex-phone" }, `device:${id}`);
  assert.equal(said.data.device, "alex-phone", "a device the report names wins");
});

test("view and one surface: context.now {surface} answers from that surface's own report", async t => {
  const { call } = await world(t);
  await call("context.report", { surface: "deck", view: "planner", project: "harlow" }, "deck");
  await call("context.report", { surface: "capsule", app: "Mail" }, "capsule");
  const deck = (await call("context.now", { surface: "deck" })).data;
  assert.equal(deck.view, "planner");
  assert.equal(deck.app, null, "the Capsule's app is not the Deck's");
  assert.equal(deck.surface, "deck");
  assert.equal((await call("context.now")).data.view, "planner", "the merge still has it");
  assert.equal((await call("context.now", { surface: "phone" })).data.surface, null, "a surface that never reported");
});
