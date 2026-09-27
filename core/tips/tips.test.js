// @ts-check
// The tips module on a fake clock and an in-memory store: what tips.next picks as the person
// moves around, the gap and the daily cap holding across calls, dismiss and reset, what's new
// after a version moves, and the hub switching tips off.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import tips, { seams } from "./index.js";
import { migrate } from "../store/index.js";
import { Events } from "../events/index.js";
import { callerAllowed } from "../modules/index.js";

const MIN = 60_000, HOUR = 60 * MIN;
let homes = 0;

const planner = [
  { id: "remind", text: "Type `vyre remind 5pm call juno` to set a reminder.", surfaces: ["cli", "deck"], level: "first-use", trigger: "on-use", since: "0.1.0" },
  { id: "snooze", text: "Press `s` on a ringing alarm to snooze it.", surfaces: ["deck"], level: "power", trigger: "on-use", since: "0.1.0", key: "s" },
  { id: "sync", text: "Your calendar now syncs both ways.", surfaces: ["deck"], level: "discovery", trigger: "after-update", since: "0.2.0" },
];
const recall = [
  { id: "try", text: "Ask `vyre recall the Harlow Legal brief` for last week's work.", surfaces: ["cli", "deck"], level: "discovery", trigger: "never-used", since: "0.1.0" },
];

/**
 * A tips module over one store. `boot()` starts it again (a restart, or an update when
 * `version` changed); `call(tool, input, caller)` checks the caller as the registry does.
 * @param {any} t @param {{ version?: string, hub?: Record<string, any>, extra?: any[] }} [o]
 */
async function world(t, { version = "0.1.0", hub = {}, extra = [] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(db);
  const root = `/tips-test-${++homes}`;
  const clock = { t: 1_800_000_000_000 };
  seams.set(root, { now: () => clock.t });
  t.after(() => seams.delete(root));
  const w = {
    db, events, clock, version, hub, logs: /** @type {string[]} */ ([]), declared: [
      { module: "planner", version: "0.1.0", firstParty: true, tips: planner },
      { module: "recall", version: "0.1.0", firstParty: true, tips: recall },
      ...extra,
    ],
    /** @type {Map<string, any>} */ tools: new Map(), handle: /** @type {any} */ (null),
    async boot() {
      if (w.handle) await w.handle.stop();
      w.tools = new Map();
      const ctx = {
        name: "tips", config: { role: "local", tips: { version: w.version } }, paths: { root },
        store: { db, migrate: (/** @type {string[]} */ steps) => migrate(db, "tips", steps) },
        log: (/** @type {string} */ m) => w.logs.push(m),
        events: { emit: (/** @type {string} */ type, /** @type {any} */ p) => events.emit("tips", type, p), on: (/** @type {string} */ p, /** @type {any} */ fn) => events.on(p, fn) },
        tool: (/** @type {string} */ name, /** @type {any} */ def) => w.tools.set(name, def),
        call: async (/** @type {string} */ tool, /** @type {any} */ input) => (tool === "settings.get" && input.key in w.hub ? { data: { value: w.hub[input.key] } } : { error: { code: "no_such_tool" } }),
        declaredTips: () => w.declared,
      };
      w.handle = await tips.start(ctx);
    },
    /** @param {string} tool @param {any} input */
    async call(tool, input = {}, caller = "deck") {
      const def = w.tools.get(tool);
      if (!callerAllowed(def.callers, caller)) return { error: { code: "denied" } };
      try { return { data: await def.run(input, { caller }) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code || "failed" } }; }
    },
    /** tips.next, and draw it if one came. @param {string} surface @param {any} context */
    async show(surface, context) {
      const r = (await w.call("tips.next", { surface, context })).data;
      if (r.tip) await w.call("tips.seen", { id: r.tip.id, surface });
      return r;
    },
  };
  await w.boot();
  t.after(() => w.handle.stop());
  return w;
}

test("tips module: next picks for the module in use, and repeats until the surface draws it", async t => {
  const w = await world(t);
  const a = (await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data;
  assert.equal(a.tip.id, "planner/remind");
  assert.equal(a.tip.whatsnew, false);
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.tip.id, "planner/remind");
  await w.call("tips.seen", { id: "planner/remind", surface: "deck" });
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.why, "gap");
});

test("tips module: the gap, the spread and two showings hold across calls", async t => {
  const w = await world(t);
  assert.equal((await w.show("deck", { module: "planner" })).tip.id, "planner/remind");
  w.clock.t += MIN;
  assert.equal((await w.show("cli", { module: "planner" })).why, "spread");
  w.clock.t += 2 * MIN;
  assert.equal((await w.show("cli", { module: "planner" })).tip.id, "planner/remind"); // its second showing
  w.clock.t += HOUR;
  assert.equal((await w.show("deck", { module: "planner" })).why, "none", "a tip shown twice came back");
});

test("tips module: six a day, then nothing until the oldest is a day old", async t => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, text: `Tip number ${i}.`, surfaces: ["deck"], level: "first-use", trigger: "on-use", since: "0.1.0" }));
  const w = await world(t, { extra: [{ module: "bakery", version: "1.0.0", firstParty: false, tips: many }] });
  for (let i = 0; i < 6; i++) { assert.ok((await w.show("deck", { module: "bakery" })).tip, `tip ${i} missing`); w.clock.t += 31 * MIN; }
  assert.equal((await w.show("deck", { module: "bakery" })).why, "cap");
  w.clock.t += 24 * HOUR;
  assert.ok((await w.show("deck", { module: "bakery" })).tip);
});

test("tips module: never-used modules only when idle; using one ends its discovery tips", async t => {
  const w = await world(t);
  assert.equal((await w.call("tips.next", { surface: "deck", context: {} })).data.why, "none");
  assert.equal((await w.call("tips.next", { surface: "deck", context: { idle: true } })).data.tip.id, "recall/try");
  await w.call("tips.used", { module: "recall" });
  assert.equal((await w.call("tips.next", { surface: "deck", context: { idle: true } })).data.why, "none");
});

test("tips module: dismiss one or a whole module; reset brings them back", async t => {
  const w = await world(t);
  await w.call("tips.dismiss", { id: "planner/remind" });
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.why, "none");
  assert.equal((await w.call("tips.dismiss", { module: "recall" })).data.dismissed, 1);
  assert.equal((await w.call("tips.next", { surface: "deck", context: { idle: true } })).data.why, "none");
  assert.equal((await w.call("tips.dismiss", { id: "planner/nope" })).error.code, "not_found");
  await w.call("tips.reset");
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.tip.id, "planner/remind");
});

test("tips module: acting on a tip retires it", async t => {
  const w = await world(t);
  await w.call("tips.seen", { id: "planner/remind", surface: "deck", acted: true });
  w.clock.t += HOUR;
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.why, "none");
});

test("tips module: an update emits tips.updated once and offers what's new until acknowledged", async t => {
  const w = await world(t);
  assert.equal(w.events.since(0, { type: "tips.updated" }).length, 0, "a first start is not an update");
  w.version = "0.2.0";
  await w.boot();
  const ev = w.events.since(0, { type: "tips.updated" });
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { module: null, from: "0.1.0", to: "0.2.0", count: 1 });
  const news = (await w.call("tips.whatsnew", {}, "cli")).data;
  assert.deepEqual(news.tips.map((/** @type {any} */ x) => x.id), ["planner/sync"]);
  await w.call("tips.used", { module: "recall" });
  const r = (await w.call("tips.next", { surface: "deck", context: { idle: true } })).data;
  assert.equal(r.tip.id, "planner/sync");
  assert.equal(r.tip.whatsnew, true);
  await w.call("tips.whatsnew", { ack: true }, "cli");
  assert.equal((await w.call("tips.whatsnew", {}, "cli")).data.tips.length, 0);
  await w.boot();
  assert.equal(w.events.since(0, { type: "tips.updated" }).length, 1, "a restart on the same version emitted again");
});

test("tips module: a module from outside is measured against its own version", async t => {
  const own = [{ id: "rye", text: "Rye orders now show in the Now view.", surfaces: ["deck"], level: "discovery", trigger: "after-update", since: "1.1.0" }];
  const w = await world(t, { extra: [{ module: "bakery", version: "1.0.0", firstParty: false, tips: own }] });
  assert.equal((await w.call("tips.whatsnew", {}, "cli")).data.tips.length, 0);
  w.declared[2] = { ...w.declared[2], version: "1.1.0" };
  await w.boot();
  assert.equal(w.events.since(0, { type: "tips.updated" }).at(-1).payload.module, "bakery");
  assert.deepEqual((await w.call("tips.whatsnew", {}, "cli")).data.tips.map((/** @type {any} */ x) => x.id), ["bakery/rye"]);
});

test("tips module: the hub turns tips off and sets the gap", async t => {
  const w = await world(t, { hub: { "tips.enabled": false } });
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.why, "off");
  w.hub["tips.enabled"] = true;
  w.hub["tips.gap_minutes"] = 60;
  w.events.emit("settings", "settings.changed", { key: "tips.enabled" });
  assert.equal((await w.show("deck", { module: "planner" })).tip.id, "planner/remind");
  w.clock.t += 45 * MIN;
  assert.equal((await w.call("tips.next", { surface: "deck", context: { module: "planner" } })).data.why, "gap");
});

test("tips module: bad tips are logged and dropped, the rest still show", async t => {
  const w = await world(t, { extra: [{ module: "bakery", version: "1.0.0", firstParty: false, tips: [{ id: "bad", text: "x" }] }] });
  assert.ok(w.logs.some(l => /bakery: teaches.tips\[0\]/.test(l)), w.logs.join("\n"));
  assert.equal((await w.call("tips.list", {}, "cli")).data.tips.length, 4);
});

test("tips module: people's surfaces choose tips; an agent may only list them", async t => {
  const w = await world(t);
  assert.equal((await w.call("tips.next", { surface: "cli" }, "mcp:agent:kit")).error.code, "denied");
  assert.equal((await w.call("tips.dismiss", { module: "recall" }, "mcp:agent:kit")).error.code, "denied");
  assert.ok((await w.call("tips.list", {}, "mcp:agent:kit")).data.tips.length);
});
