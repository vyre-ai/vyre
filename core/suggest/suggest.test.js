// @ts-check
// suggest against fake agents, projects, threads, planner and vault modules in a temp home. The
// fakes read their answers from one shared object and count every call, so a test can say that a
// keystroke called nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { quality, prepare, tokenAt, EXACT, PREFIX, WORD, ID, INSIDE, SPREAD } from "./match.js";
import { discover, Registry } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";

const wait = ms => new Promise(r => setTimeout(r, ms));
const HOUR = 3_600_000;

test("tokenAt: the token at the cursor picks the lane", () => {
  assert.deepEqual(tokenAt("ask @ju"), { lane: "mention", prefix: "ju", token: "@ju", start: 4, end: 7 });
  assert.equal(tokenAt("@").lane, "mention");
  assert.equal(tokenAt("@").prefix, "");
  assert.deepEqual(tokenAt("/pl"), { lane: "command", prefix: "pl", token: "/pl", start: 0, end: 3 });
  assert.equal(tokenAt("open /Users/alex").lane, "text", "a path is not a command");
  assert.equal(tokenAt("mail alex@harlow").lane, "text", "an address is not a mention");
  assert.deepEqual(tokenAt("email har tomorrow", 9), { lane: "text", prefix: "har", token: "har", start: 6, end: 9 });
  assert.equal(tokenAt("done ").prefix, "", "after a space nothing is being typed");
});

test("quality: exact, prefix, word start, words, id, inside, letters in order", () => {
  const p = prepare("Northwind Bakery", "northwind");
  assert.equal(quality("northwind bakery", p), EXACT);
  assert.equal(quality("northwind", p), EXACT, "the id typed out");
  assert.equal(quality("north", p), PREFIX);
  assert.equal(quality("bak", p), WORD);
  assert.equal(quality("nor bak", p), WORD);
  assert.equal(quality("3f2a", prepare("rebuild menu", "3f2a9c1d-0000"), { idPrefix: true }), ID);
  assert.equal(quality("3f2a", prepare("rebuild menu", "3f2a9c1d-0000")), 0, "only threads match by id");
  assert.equal(quality("hwin", p), INSIDE);
  assert.equal(quality("nwd", p), SPREAD);
  assert.equal(quality("zz", p), 0);
  assert.equal(quality("", p), INSIDE, "@ alone lists everything");
});

/** Fake modules answer from globalThis.SUGGEST_FAKE and count calls there. */
const FAKE = (tools, emits, offers = []) => `export default { async start(ctx) {
  const F = globalThis.SUGGEST_FAKE;
  for (const t of ${JSON.stringify(tools)}) {
    if (t.endsWith(".poke")) { ctx.tool(t, { run: async ({ type, payload }) => { ctx.events.emit(type, payload || {}); return true; } }); continue; }
    if (t.endsWith(".spoof")) { ctx.tool(t, { run: async input => ctx.call("suggest.offer", input) }); continue; }
    ctx.tool(t, { internal: ${JSON.stringify(offers.map(o => o.tool))}.includes(t), run: async input => {
      F.calls[t] = (F.calls[t] || 0) + 1; F.inputs[t] = input;
      if (F.delay[t]) await new Promise(r => setTimeout(r, F.delay[t]));
      const d = F.data[t];
      return typeof d === "function" ? d(input) : d;
    } });
  }
  for (const o of ${JSON.stringify(offers)}) F.offered.push(await ctx.call("suggest.offer", o));
  return {};
} };`;

const now = Date.now();
const DATA = () => ({
  "agents.list": [{ name: "juno", kind: "assistant", doing: "idle" }, { name: "kit", kind: "agent", doing: "working" }, { name: "north", kind: "agent", doing: "idle" }],
  "projects.list": { projects: [
    { slug: "northwind", name: "Northwind Bakery", org: "Northwind", people: [{ name: "Priya Shah", email: "priya@northwind.test" }], threads: 3, last: now - 2 * HOUR },
    { slug: "harlow", name: "Harlow Legal", people: [{ name: "alex" }, "Jordan"], threads: 5, last: now - 20 * HOUR },
  ], problems: [] },
  "threads.list": [
    { id: "3f2a9c1d-1111-4000-8000-000000000001", name: "northwind rebuild", project: "northwind", cwd: "/srv/northwind", status: "working", last: now - 60_000 },
    { id: "7b7b0000-2222-4000-8000-000000000002", name: "", project: null, cwd: "/srv/harlow-site", status: "idle", last: now - 5 * HOUR },
  ],
  "planner.upcoming": { tz: "UTC", entries: [
    { key: "planner-p1-1", item: "p1", kind: "reminder", title: "Harlow filing deadline", at: now + 3 * HOUR },
    { key: "planner-p1-2", item: "p1", kind: "reminder", title: "Harlow filing deadline", at: now + 27 * HOUR },
    { key: "planner-p2-1", item: "p2", kind: "event", title: "Northwind tasting", at: now + 5 * HOUR, start: now + 5.25 * HOUR },
  ] },
  "vault.connections.list": [{ id: "c1", source: "google", provider: "google", account: "alex@harlow.test", label: "Harlow mail", capabilities: ["send_mail"],
    use: { tool: "google.mail.send", input: { account: "alex@harlow.test" } } }],
});

const SOURCES = [
  ["agents", ["agents.list", "agents.poke"], ["agents.changed"]],
  ["projects", ["projects.list", "projects.poke"], ["project.changed", "project.created"]],
  ["threads", ["threads.list", "threads.poke"], ["thread.started", "thread.finished", "thread.text"]],
  ["planner", ["planner.upcoming", "planner.poke"], ["planner.added"]],
  ["vault", ["vault.connections.list"], []],
];

/**
 * suggest with the given fakes. `fakes` names which of SOURCES to run (default all); `extra` adds
 * modules that offer sources: [name, tools, offers].
 */
async function world(t, { fakes = SOURCES.map(s => s[0]), extra = [], data = DATA() } = {}) {
  const home = tempHome(t);
  const root = path.join(home, "mods");
  /** @type {any} */ (globalThis).SUGGEST_FAKE = { calls: {}, inputs: {}, delay: {}, data, offered: [] };
  for (const [name, tools, emits] of SOURCES.filter(s => fakes.includes(s[0])))
    writeModule(root, name, { roles: ["box", "local"], does: { tools }, watches: { emits } }, FAKE(tools, emits));
  for (const [name, tools, offers] of extra)
    writeModule(root, name, { roles: ["box", "local"], requires: ["suggest"], does: { tools } }, FAKE(tools, [], offers));
  const db = open(path.join(home, "vyre.db"));
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local" }, paths: { root: home }, log: () => {} });
  const core = discover([path.join(path.dirname(new URL(import.meta.url).pathname), "..")]).filter(f => f.manifest?.name === "suggest");
  await reg.start([...core, ...discover([root])], { role: "local" });
  t.after(async () => { await reg.stop?.(); db.close(); });
  const F = /** @type {any} */ (globalThis).SUGGEST_FAKE;
  const q = async (text, more = {}) => {
    const r = await reg.call("suggest.query", { text, surface: "capsule", ...more }, "capsule");
    assert.ok(!r.error, JSON.stringify(r.error));
    return r.data;
  };
  return { reg, db, F, q, status: () => reg.status() };
}

const labels = r => r.items.map(i => i.label);

test("mention lane: @ lists agents, projects, threads and people; agents before projects before threads on an equal match", async t => {
  const { q, status } = await world(t);
  assert.equal(status().find(m => m.name === "suggest")?.state, "running");

  const all = await q("ask @", { limit: 20 });
  assert.deepEqual(all.items.slice(0, 3).map(i => i.sub), ["agent", "agent", "agent"]);
  assert.deepEqual(new Set(all.items.map(i => i.sub)), new Set(["agent", "project", "thread", "person"]));
  const juno = all.items.find(i => i.label === "juno");
  assert.deepEqual({ ...juno, score: 0 }, { kind: "mention", sub: "agent", label: "juno", insert: "@juno", detail: "your assistant", source: "agents", id: "juno", score: 0 });

  // "nor": agent north, project Northwind Bakery, thread "northwind rebuild" all start with it.
  // The thread is the most recent of the three, and still ranks below both.
  const nor = await q("ping @nor");
  assert.deepEqual(nor.items.map(i => [i.sub, i.label]), [["agent", "north"], ["project", "Northwind Bakery"], ["thread", "northwind rebuild"]]);
  assert.equal(nor.items[1].insert, "@northwind");
  assert.equal(nor.items[2].insert, "@3f2a9c1d");
  assert.equal(nor.items[1].detail, "Northwind · 3 threads");

  const byId = await q("@3f2a");
  assert.equal(byId.items[0].id, "3f2a9c1d-1111-4000-8000-000000000001", "a thread by its id's start, as in the Capsule");
  const unnamed = (await q("@7b7b")).items[0];
  assert.equal(unnamed.label, "7b7b0000", "a thread with no name shows its short id");
  assert.equal(unnamed.detail, "harlow-site");

  const pri = await q("@pri");
  assert.deepEqual(pri.items.map(i => [i.sub, i.label, i.id, i.detail]), [["person", "Priya Shah", "priya@northwind.test", "Northwind Bakery"]]);
  assert.equal(typeof pri.ms, "number");
  assert.equal(pri.late, undefined);
});

test("command lane: only offered command sources; no built-in list is read", async t => {
  const { q, F } = await world(t, { extra: [["does", ["does.commands", "does.words"], [{ tool: "does.commands", kinds: ["command"] }, { tool: "does.words", kinds: ["phrase"] }]]] });
  F.data["does.commands"] = ({ prefix }) => [{ label: "/plan", insert: "/plan ", detail: "Plan the work" }, { label: "/pull", insert: "/pull " }].filter(c => c.label.slice(1).startsWith(prefix));
  F.data["does.words"] = [{ label: "should not appear" }];
  const r = await q("/pl");
  assert.deepEqual(r.items.map(i => [i.kind, i.label, i.insert, i.source]), [["command", "/plan", "/plan ", "does.commands"]]);
  assert.deepEqual(F.inputs["does.commands"], { prefix: "pl", text: "/pl", surface: "capsule", context: {}, limit: 8 });
  assert.equal(F.calls["does.words"], undefined, "a phrase source is not asked for a command");
  for (const tool of ["agents.list", "projects.list", "threads.list"]) assert.equal(F.calls[tool], undefined, tool);
  assert.deepEqual((await q("/")).items.length, 2);
});

test("text lane: names on the last word insert plain, plus accounts, upcoming times and offered entities", async t => {
  const { q, F } = await world(t, { extra: [["memory", ["memory.entities"], [{ tool: "memory.entities", kinds: ["entity"] }]]] });
  F.data["memory.entities"] = ({ prefix }) => ({ items: [{ label: "Harlow v. Northwind", id: "e7", detail: "case", score: 0.9 }, { label: "harlow", kind: "person" }].filter(() => prefix === "harlow") });

  const r = await q("send the notes to harlow", { context: { project: "harlow" } });
  const got = Object.fromEntries(r.items.map(i => [`${i.kind}:${i.label}`, i]));
  assert.equal(got["mention:Harlow Legal"].insert, "Harlow Legal", "running text gets the name, not an @, even when the slug was typed whole");
  assert.equal(got["account:Harlow mail"].detail, "google · alex@harlow.test");
  assert.deepEqual(got["account:Harlow mail"].action, { tool: "google.mail.send", input: { account: "alex@harlow.test" } });
  assert.match(got["time:Harlow filing deadline"].detail, /^reminder, in 3 h$/, "the soonest ring of a repeating item");
  assert.deepEqual(got["time:Harlow filing deadline"].action, { tool: "planner.get", input: { item: "p1" } });
  assert.equal(got["entity:Harlow v. Northwind"].source, "memory.entities");
  assert.equal(got["entity:Harlow v. Northwind"].id, "e7");
  assert.ok(!r.items.some(i => i.kind === "person"), "an item of a kind the source did not offer is dropped");
  assert.deepEqual(F.inputs["memory.entities"].context, { project: "harlow" });
  assert.equal(F.inputs["vault.connections.list"].surface, "capsule", "connections are asked for the caller's surface");

  assert.deepEqual((await q("say h")).items, [], "one letter is too little for the built-in lists");
  assert.ok(!(await q("tell juno")).items.some(i => i.label === "juno"), "a name typed out whole needs no suggestion");
  assert.ok((await q("tell ju")).items.some(i => i.label === "juno" && i.insert === "juno"));
});

test("picked: a chosen item ranks higher next time, and the pick is stored", async t => {
  const { q, reg, db } = await world(t);
  const before = await q("@nor");
  assert.equal(before.items[2].sub, "thread");
  const thread = before.items[2];
  const r = await reg.call("suggest.picked", { kind: thread.kind, source: thread.source, id: thread.id }, "capsule");
  assert.equal(r.data.weight, 1);
  const after = await q("@nor");
  assert.equal(after.items[0].id, thread.id, "one pick lifts a thread over an agent on the same match");
  assert.ok(after.items[0].score > before.items[2].score);
  const row = /** @type {any} */ (db.prepare("SELECT * FROM suggest_picks").get());
  assert.deepEqual({ kind: row.kind, source: row.source, id: row.id, weight: row.weight }, { kind: "mention", source: "threads", id: thread.id, weight: 1 });
  assert.equal((await reg.call("suggest.picked", { kind: "mention", source: "threads", id: thread.id }, "capsule")).data.weight > 1.99, true);
  assert.equal((await reg.call("suggest.picked", { kind: "nope", source: "x", id: "y" }, "capsule")).error.code, "bad_input");
  assert.equal((await reg.call("suggest.picked", { kind: "mention", source: "x", id: "y" }, "mcp")).error.code, "denied", "not for Claude");
});

test("offer: modules only, their own tools only, known kinds only; offering again replaces", async t => {
  const { reg, F, q } = await world(t, { fakes: [], extra: [["memory", ["memory.entities", "memory.spoof"], [{ tool: "memory.entities", kinds: ["entity"] }]]] });
  assert.deepEqual(F.offered, [{ data: { tool: "memory.entities", kinds: ["entity"] } }]);
  assert.equal((await reg.call("suggest.offer", { tool: "x.y", kinds: ["entity"] }, "cli")).error.code, "no_such_tool", "people and Claude never see it");
  assert.equal((await reg.call("suggest.offer", { tool: "x.y", kinds: ["entity"] }, "mcp")).error.code, "no_such_tool");
  const spoof = async input => (await reg.call("memory.spoof", input, "cli")).data;
  assert.match((await spoof({ tool: "agents.list", kinds: ["mention"] })).error.message, /only one of its own tools/);
  assert.match((await spoof({ tool: "memoryx.entities", kinds: ["entity"] })).error.message, /only one of its own tools/);
  assert.equal((await spoof({ tool: "memory.entities", kinds: ["gossip"] })).error.code, "bad_input");
  assert.match((await spoof({ tool: "memory.entities", kinds: [] })).error.message, /kinds must be/);
  F.data["memory.entities"] = [{ label: "Northwind oven" }];
  assert.deepEqual(labels(await q("nor")), ["Northwind oven"]);
  // Offered again, as commands only: the text lane no longer asks it.
  assert.deepEqual((await spoof({ tool: "memory.entities", kinds: ["command"] })).data, { tool: "memory.entities", kinds: ["command"] });
  assert.deepEqual(labels(await q("nor")), [], "the new offer replaced the old kinds");
  assert.equal(F.calls["memory.entities"], 1);
});

test("deadline: a source that misses 25 ms is dropped from that keystroke and named in late", async t => {
  const { q, F } = await world(t, { fakes: [], extra: [
    ["memory", ["memory.entities"], [{ tool: "memory.entities", kinds: ["entity"] }]],
    ["slow", ["slow.words"], [{ tool: "slow.words", kinds: ["phrase"] }]],
  ] });
  F.data["memory.entities"] = [{ label: "Northwind Bakery" }];
  F.data["slow.words"] = [{ label: "northwind ovens are in" }];
  F.delay["slow.words"] = 120;
  const r = await q("nor");
  assert.deepEqual(labels(r), ["Northwind Bakery"]);
  assert.deepEqual(r.late, ["slow.words"]);
  assert.ok(r.ms < 100, `answered in ${r.ms} ms`);
  const again = await q("nort");
  assert.deepEqual(again.late, ["slow.words"], "still answering the last keystroke: not asked again");
  assert.equal(F.calls["slow.words"], 1);
  await wait(150);
  F.delay["slow.words"] = 0;
  const later = await q("north");
  assert.equal(later.late, undefined);
  assert.deepEqual(labels(later).sort(), ["Northwind Bakery", "northwind ovens are in"]);
});

test("cache: lists load on the first query, keystrokes call nothing, and an owner's event reloads only its list", async t => {
  const { q, F, reg } = await world(t);
  assert.deepEqual(F.calls, {}, "nothing is read before the first query");
  await q("@");
  for (const s of ["@n", "@no", "@nor", "@nort", "@j", "@ju", "hello harl", "hello harlo"]) await q(s);
  assert.deepEqual(F.calls, { "agents.list": 1, "projects.list": 1, "threads.list": 1, "planner.upcoming": 1, "vault.connections.list": 1 });

  F.data["projects.list"] = { projects: [{ slug: "kit-shop", name: "Kit Shop", threads: 0, last: now }] };
  await reg.call("projects.poke", { type: "project.created" }, "cli");
  await reg.call("projects.poke", { type: "project.changed" }, "cli");
  await wait(150);
  assert.equal(F.calls["projects.list"], 2, "a burst of events is one reload");
  assert.ok(labels(await q("@kit")).includes("Kit Shop"));
  assert.ok(!labels(await q("@", { limit: 20 })).includes("Harlow Legal"));

  F.data["threads.list"] = [{ id: "aaaa0000-0000-4000-8000-000000000009", name: "juno bake plan", status: "idle", last: now }];
  await reg.call("threads.poke", { type: "thread.text" }, "cli");
  await wait(100);
  assert.equal(F.calls["threads.list"], 1, "a thread's text is not a change to the list");
  await reg.call("threads.poke", { type: "thread.started" }, "cli");
  await wait(150);
  assert.equal(F.calls["threads.list"], 2);
  assert.ok(labels(await q("@bake")).includes("juno bake plan"));
  assert.equal(F.calls["agents.list"], 1);
  await reg.call("agents.poke", { type: "agents.changed" }, "cli");
  await wait(150);
  assert.equal(F.calls["agents.list"], 2);
});

test("degrade: with no source modules at all, answers are empty, never errors", async t => {
  const { q } = await world(t, { fakes: [] });
  for (const s of ["@", "@ju", "/pl", "mail harlow", ""]) {
    const r = await q(s);
    assert.deepEqual(r.items, [], s);
    assert.equal(r.late, undefined, s);
  }
  // Some sources present, some not: the present ones still answer.
  const t2 = await world(t, { fakes: ["agents"] });
  assert.deepEqual(labels(await t2.q("@ju")), ["juno"]);
});

test("limits: 8 by default, never more than 20; duplicates by kind and label collapse", async t => {
  const agents = Array.from({ length: 30 }, (_, i) => ({ name: `kit-${String(i).padStart(2, "0")}`, kind: "agent" }));
  const { q } = await world(t, { fakes: ["agents", "projects"], data: { ...DATA(), "agents.list": agents,
    "projects.list": { projects: [{ slug: "kit-00", name: "kit-00" }] } } });
  assert.equal((await q("@kit")).items.length, 8);
  assert.equal((await q("@kit", { limit: 50 })).items.length, 20);
  const dup = (await q("@kit-00")).items.filter(i => i.label === "kit-00");
  assert.equal(dup.length, 1, "agent and project named alike: one row, the agent's");
  assert.equal(dup[0].sub, "agent");
});

test("perf: p95 well under budget with 500 threads cached", async t => {
  const threads = Array.from({ length: 500 }, (_, i) => ({ id: `${(0x10000000 + i).toString(16)}-0000-4000-8000-000000000000`,
    name: `${["northwind", "harlow", "juno", "kit", "bakery"][i % 5]} task ${i}`, project: i % 2 ? "northwind" : "harlow", cwd: "/srv/x", status: "idle", last: now - i * 60_000 }));
  const { q } = await world(t, { data: { ...DATA(), "threads.list": threads } });
  await q("@");
  const texts = ["@", "@n", "@no", "@nor", "@north", "@ha", "@task 4", "@zz", "@1000", "ping har", "ping harlow", "note bak", "@k", "@ju"];
  const ms = [];
  for (let i = 0; i < 300; i++) { const t0 = performance.now(); await q(texts[i % texts.length]); ms.push(performance.now() - t0); }
  ms.sort((a, b) => a - b);
  const p50 = ms[Math.floor(ms.length * 0.5)], p95 = ms[Math.floor(ms.length * 0.95)];
  console.log(`suggest perf, 500 threads, through reg.call: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${ms[ms.length - 1].toFixed(2)} ms`);
  assert.ok(p95 < 50, `p95 ${p95.toFixed(2)} ms`);
});
