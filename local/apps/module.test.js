// @ts-check
// The module through the real Registry, over fakes: the manifest, the four tools, apps.list's
// tiers, the targets cache, the act/send split, and apps.send's presence and its preview.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { Presence } from "../../core/presence/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { fakeExec, fakeApp } from "./fake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A made-up app with one sending action and one that sends nothing, as a later slice's WhatsApp will have. */
const chatApp = () => {
  /** @type {any[]} */
  const sent = [];
  return {
    sent,
    adapter: {
      id: "chatter", app: "Chatter", bundleIds: ["com.example.chatter"], tier: "ax",
      actions: {
        message: {
          title: "Send a message", sends: true,
          input: { type: "object", required: ["to", "text"], properties: { to: { type: "string" }, text: { type: "string" } } },
          preview: (/** @type {any} */ a) => `Chatter → ${a.to}: ${a.text}`,
          run: async (/** @type {any} */ a) => { sent.push(a); return { said: `Sent to ${a.to}` }; },
        },
        open: { title: "Open a chat", sends: false, input: { type: "object", properties: {} }, run: async () => ({ said: "Opened" }) },
      },
      targets: async (/** @type {string} */ q) => [{ id: "juno", title: "juno", kind: "contact" }, { id: "kit", title: "kit", kind: "contact" }].filter(x => x.id.includes(q)),
    },
  };
};

/**
 * Start the module in a Registry with fakes, optionally with presence enforced.
 * @param {any} t @param {{ apps?: any, presence?: boolean }} [o]
 */
async function start(t, { apps = {}, presence = false, modules = /** @type {string[]} */ ([]) } = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const events = new Events(db);
  const p = presence ? new Presence({ db, events, platform: "linux", touchid: null, webauthn: null, who: async () => [], writeTty: () => {} }) : undefined;
  const f = fakeExec(() => ({}));
  const reg = new Registry({ db, events, log: () => {}, presence: p,
    config: { role: "local", apps: { exec: f.exec, platform: "darwin", tmpdir: home, dirs: [path.join(home, "Applications")], fetch: async () => { throw new Error("no network in tests"); }, ...apps } } });
  const extra = modules.length ? discover(modules.map(d => path.dirname(d))).filter(m => modules.includes(m.dir)) : [];
  await reg.start([...discover([path.dirname(HERE)]).filter(m => m.dir === HERE), ...extra], { role: "local" });
  t.after(() => reg.stop());
  return { reg, home, calls: f.calls, events: () => reg.deps.events.since(0) };
}

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
});

test("module: starts in the Registry, registers its tools, and starting runs nothing", async t => {
  const { reg, calls } = await start(t);
  assert.equal(reg.status().find(m => m.name === "apps")?.state, "running");
  assert.deepEqual(reg.listTools().map(x => x.name).sort(), ["apps.act", "apps.list", "apps.route", "apps.send", "apps.setup", "apps.targets"]);
  assert.equal(reg.listTools().find(x => x.name === "apps.send")?.presence, true);
  assert.equal(reg.listTools().find(x => x.name === "apps.act")?.presence, undefined);
  assert.equal(calls.length, 0);
});

test("module: apps.list gives each app its adapter's tier, else ax", async t => {
  const { reg, home } = await start(t);
  const dir = path.join(home, "Applications");
  fakeApp(dir, "Notes", "com.apple.Notes");
  fakeApp(dir, "Clock", "com.apple.clock");
  fakeApp(dir, "Northwind Bakery POS", "com.example.pos");
  const r = await reg.call("apps.list", {}, "cli");
  assert.deepEqual(r.data.apps.map((/** @type {any} */ a) => [a.name, a.tier]), [["Clock", "intents"], ["Northwind Bakery POS", "ax"], ["Notes", "script"]]);
  assert.deepEqual((await reg.call("apps.list", { q: "bak" }, "cli")).data.apps.map((/** @type {any} */ a) => a.name), ["Northwind Bakery POS"]);
});

test("module: apps.act runs an action, emits apps.acted without the user's text, and returns said", async t => {
  const { reg, calls, events } = await start(t, { apps: { exec: fakeExec(() => ({ stdout: "R1\n" })).exec } });
  const r = await reg.call("apps.act", { app: "reminders", action: "create", args: { text: "call juno about Harlow Legal" } }, "cli");
  assert.equal(r.data.said, "Reminder: call juno about Harlow Legal");
  const ev = events().filter((/** @type {any} */ e) => e.type === "apps.acted");
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].payload, { app: "Reminders", action: "create" });
  assert.ok(!JSON.stringify(ev).includes("juno"));
  assert.equal(calls.length, 0, "the config exec replaced the default one");
});

test("module: apps.act refuses unknown apps and actions, bad args, and any sending action", async t => {
  const chat = chatApp();
  const { reg } = await start(t, { apps: { adapters: [chat.adapter] } });
  const nope = await reg.call("apps.act", { app: "Photoshop", action: "open" }, "cli");
  assert.equal(nope.error.code, "not_found");
  const noAction = await reg.call("apps.act", { app: "Clock", action: "stopwatch" }, "cli");
  assert.equal(noAction.error.code, "not_found");
  assert.match(noAction.error.message, /timer, alarm/);
  assert.equal((await reg.call("apps.act", { app: "Clock", action: "timer", args: { seconds: "ten" } }, "cli")).error.code, "bad_input");
  assert.equal((await reg.call("apps.act", { app: "Clock", action: "timer", args: {} }, "cli")).error.code, "bad_input");
  const sends = await reg.call("apps.act", { app: "Chatter", action: "message", args: { to: "juno", text: "hi" } }, "cli");
  assert.equal(sends.error.code, "sends");
  assert.match(sends.error.message, /apps\.send/);
  assert.match(sends.error.message, /person/);
  assert.equal(chat.sent.length, 0);
  assert.equal((await reg.call("apps.act", { app: "chatter", action: "open" }, "cli")).data.said, "Opened");
});

test("module: apps.send refuses an action that sends nothing with not_sends", async t => {
  const chat = chatApp();
  const { reg } = await start(t, { apps: { adapters: [chat.adapter] } });
  assert.equal((await reg.call("apps.send", { app: "Clock", action: "timer", args: { seconds: 60 } }, "module:test")).error.code, "not_sends");
  assert.equal((await reg.call("apps.send", { app: "Chatter", action: "open" }, "module:test")).error.code, "not_sends");
});

test("module: apps.send needs a person's proof from every non-module caller, and shows the preview", async t => {
  const chat = chatApp();
  const { reg, events } = await start(t, { apps: { adapters: [chat.adapter] }, presence: true });
  const input = { app: "Chatter", action: "message", args: { to: "juno", text: "running 10 min late" } };
  for (const caller of ["cli", "capsule", "mcp", "mcp:agent:kit", "local"]) {
    const r = await reg.call("apps.send", input, caller);
    assert.equal(r.error && r.error.code, "presence_required", `${caller} sent without a proof`);
  }
  assert.equal(chat.sent.length, 0);
  const def = reg.tools.get("apps.send");
  const presence = /** @type {Presence} */ (reg.deps.presence);
  assert.equal(await presence.summary("apps.send", input, def), "Chatter → juno: running 10 min late");
  assert.equal(await presence.summary("apps.send", { app: "Chatter", action: "wave" }, def), "Chatter wave");
  // A module is the only caller the loader vouches for; it goes through.
  const ok = await reg.call("apps.send", input, "module:test");
  assert.equal(ok.data.said, "Sent to juno");
  assert.deepEqual(chat.sent, [input.args]);
  assert.deepEqual(events().filter((/** @type {any} */ e) => e.type === "apps.sent").map((/** @type {any} */ e) => e.payload), [{ app: "Chatter", action: "message" }]);
});

test("module: apps.targets caches per app and query for 60 s, expiring on read; none for an app without targets", async t => {
  let now = 0, asked = 0;
  const chat = chatApp();
  const inner = chat.adapter.targets;
  chat.adapter.targets = async q => { asked++; return inner(q); };
  const { reg } = await start(t, { apps: { adapters: [chat.adapter], now: () => now } });
  assert.deepEqual((await reg.call("apps.targets", { app: "Chatter", q: "ju" }, "cli")).data.targets.map((/** @type {any} */ x) => x.id), ["juno"]);
  await reg.call("apps.targets", { app: "chatter", q: "ju" }, "cli");
  assert.equal(asked, 1);
  await reg.call("apps.targets", { app: "Chatter", q: "" }, "cli");
  assert.equal(asked, 2, "another query has its own entry");
  now += 60_001;
  await reg.call("apps.targets", { app: "Chatter", q: "ju" }, "cli");
  assert.equal(asked, 3);
  assert.equal((await reg.call("apps.targets", { app: "Chatter", limit: 1 }, "cli")).data.targets.length, 1);
  assert.deepEqual((await reg.call("apps.targets", { app: "Clock" }, "cli")).data, { targets: [] });
  assert.deepEqual((await reg.call("apps.targets", { app: "Photoshop" }, "cli")).data, { targets: [] });
});

test("module: a setup error keeps its code through the Registry", async t => {
  const { reg } = await start(t, { apps: { exec: fakeExec(() => ({ stdout: "Some Other Shortcut\n" })).exec } });
  const r = await reg.call("apps.act", { app: "Clock", action: "timer", args: { seconds: 600 } }, "cli");
  assert.equal(r.error.code, "setup");
  assert.match(r.error.message, /vyre apps setup clock/);
});

test("module: apps.list returns at most 100 rows, whatever limit asks", async t => {
  const { reg, home } = await start(t);
  for (let i = 0; i < 105; i++) fakeApp(path.join(home, "Applications"), `App ${String(i).padStart(3, "0")}`, null);
  assert.equal((await reg.call("apps.list", { limit: 1000 }, "cli")).data.apps.length, 100);
  assert.equal((await reg.call("apps.list", { limit: 0 }, "cli")).data.apps.length, 1);
});

test("module: expired targets go when a new entry is written, and an act on an app clears its targets", async t => {
  let now = 0, asked = 0;
  const chat = chatApp();
  const inner = chat.adapter.targets;
  chat.adapter.targets = async q => { asked++; return inner(q); };
  const { reg } = await start(t, { apps: { adapters: [chat.adapter], now: () => now } });
  const handle = reg.modules.get("apps")?.handle;
  for (const q of ["a", "b", "c"]) await reg.call("apps.targets", { app: "Chatter", q }, "cli");
  assert.equal(handle.cachedTargets(), 3);
  now += 60_001;
  await reg.call("apps.targets", { app: "Chatter", q: "d" }, "cli");
  assert.equal(handle.cachedTargets(), 1, "expired entries were kept");
  await reg.call("apps.targets", { app: "Chatter", q: "d" }, "cli");
  assert.equal(asked, 4);
  await reg.call("apps.act", { app: "Chatter", action: "open" }, "cli");
  assert.equal(handle.cachedTargets(), 0);
  await reg.call("apps.targets", { app: "Chatter", q: "d" }, "cli");
  assert.equal(asked, 5, "targets were served from before the act");
});

test("module: a presence session proves apps.send; a session never proves a tool off the floor's list", async t => {
  const chat = chatApp();
  const { reg } = await start(t, { apps: { adapters: [chat.adapter] }, presence: true });
  const presence = /** @type {Presence} */ (reg.deps.presence);
  const input = { app: "Chatter", action: "message", args: { to: "kit", text: "on my way" } };
  assert.equal((await reg.call("apps.send", input, "capsule")).error.code, "presence_required");
  const s = presence.openSession({ method: "capsule", keyId: "k1" });
  const proof = { method: "session", id: s.session, secret: s.secret };
  const sent = await reg.call("apps.send", input, "capsule", { proof });
  assert.equal(sent.data && sent.data.said, "Sent to kit", JSON.stringify(sent));
  assert.equal((await reg.call("apps.send", { ...input, args: { to: "juno", text: "and you" } }, "capsule", { proof })).data.said, "Sent to juno");
  assert.equal(chat.sent.length, 2);
  const wrong = await reg.call("apps.send", input, "capsule", { proof: { ...proof, secret: "not-it" } });
  assert.equal(wrong.error.code, "presence_required");
  // A tool that says yes to sessions but is not on SESSIONABLE is still refused.
  const other = await presence.verify({ tool: "vault.delete", input: {}, caller: "capsule", proof, def: { presence: { session: () => true } } });
  assert.equal(other.ok, false);
  assert.match(other.message, /needs its own proof/);
  assert.equal(chat.sent.length, 2);
});

test("module: apps.route routes words by rules with the module's clock and zone, and runs nothing", async t => {
  const now = Date.UTC(2026, 8, 24, 10, 0);
  const { reg, calls, events } = await start(t, { modules: [parsingPlanner(path.join(tempHome(t), "mods"))], apps: { now: () => now, timeZone: "Asia/Karachi", planner: "apple" } });
  const r = await reg.call("apps.route", { text: "remind me to call juno at 6" }, "capsule");
  assert.deepEqual(r.data.args, { text: "call juno", due: "2026-09-24T18:00" });
  assert.equal((await reg.call("apps.route", { text: "buy milk", app: "Notes" }, "capsule")).data.action, "create");
  assert.equal(calls.length, 0);
  assert.equal(events().filter((/** @type {any} */ e) => e.type.startsWith("apps.")).length, 0);
});

test("module: the model seam runs only for ambiguous words, only when asked, and sends come from the adapter", async t => {
  /** @type {any[]} */
  const asked = [];
  const chat = chatApp();
  const model = async (/** @type {string} */ text, /** @type {any[]} */ apps) => {
    asked.push({ text, apps });
    if (text.includes("lie")) return { app: "Chatter", action: "message", args: { to: "juno", text: "hi" }, sends: false, said: "Timer for 5 minutes" };
    if (text.includes("junk")) return { nope: true };
    if (text.includes("throw")) throw new Error("model down");
    return { app: "Clock", action: "timer", args: { seconds: 300 }, said: "Timer for 5 minutes" };
  };
  const { reg } = await start(t, { apps: { model, adapters: [chat.adapter] } });
  assert.deepEqual((await reg.call("apps.route", { text: "timer 10 min", model: true }, "capsule")).data.args, { text: "timer 10 min", kind: "timer" });
  assert.equal(asked.length, 0, "the model was asked about words the rules placed");
  assert.equal((await reg.call("apps.route", { text: "brew a tea for five minutes" }, "capsule")).data.ambiguous, true);
  assert.equal(asked.length, 0, "the model was asked without model: true");
  const m = await reg.call("apps.route", { text: "brew a tea for five minutes", model: true }, "capsule");
  assert.deepEqual(m.data, { app: "Clock", action: "timer", args: { seconds: 300 }, sends: false, said: "Clock timer", via: "model" });
  assert.ok(asked[0].apps.find((/** @type {any} */ a) => a.app === "Clock").actions.some((/** @type {any} */ x) => x.name === "timer"));
  const lie = (await reg.call("apps.route", { text: "lie to me", model: true }, "capsule")).data;
  assert.equal(lie.sends, true, "the model's sends: false was trusted");
  assert.equal(lie.said, "Chatter → juno: hi", "the preview was not built from the args");
  assert.equal((await reg.call("apps.route", { text: "junk please", model: true }, "capsule")).data.ambiguous, true);
  assert.equal((await reg.call("apps.route", { text: "throw it", model: true }, "capsule")).data.ambiguous, true);
});

test("module: apps.setup sets up Clock under the Vyre home and refuses an app that needs none", async t => {
  const home = tempHome(t);
  const f = fakeExec((file, args) => (args[0] === "sign" ? (fs.writeFileSync(args[args.indexOf("--output") + 1], "x"), {}) : {}));
  const { reg } = await start(t, { apps: { exec: f.exec, setupDir: path.join(home, "shortcuts") } });
  const r = await reg.call("apps.setup", { app: "clock" }, "cli");
  assert.deepEqual(r.data.files.map((/** @type {string} */ x) => path.basename(x)), ["Vyre Timer.shortcut", "Vyre Alarm.shortcut"]);
  assert.equal((await reg.call("apps.setup", { app: "Notes" }, "cli")).error.code, "not_supported");
  assert.equal((await reg.call("apps.setup", { app: "Photoshop" }, "cli")).error.code, "not_supported");
});

test("module: apps.setup answers only the surfaces a person drives", async t => {
  const home = tempHome(t);
  const f = fakeExec((file, args) => (args[0] === "sign" ? (fs.writeFileSync(args[args.indexOf("--output") + 1], "x"), {}) : {}));
  const { reg } = await start(t, { apps: { exec: f.exec, setupDir: path.join(home, "shortcuts") } });
  for (const caller of ["mcp", "mcp:agent:kit", "harness:agent:kit", "module:chat", "anonymous", "local", "tailnet-guest:juno", "tailnet:agent:kit"]) {
    const r = await reg.call("apps.setup", { app: "clock" }, caller);
    assert.equal(r.error && r.error.code, "denied", `${caller} ran apps.setup`);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(reg.listTools("mcp").some(x => x.name === "apps.setup"), false);
  for (const caller of ["cli", "capsule", "deck", "tailnet:alex"]) assert.ok((await reg.call("apps.setup", { app: "clock" }, caller)).data, caller);
});


/** A stand-in for the box's planner module (ADR 0025): planner.add keeps what it is given. */
function fakePlanner(/** @type {string} */ root, /** @type {string} */ answer = "{ id: 'itm_1', kind: i.kind || 'note', title: 'call juno' }") {
  return writeModule(root, "planner", { roles: ["local"], does: { tools: ["planner.add"] } }, `
export default { async start(ctx) {
  globalThis.__plannerCalls = [];
  ctx.tool("planner.add", { input: { type: "object" }, async run(i, meta) { globalThis.__plannerCalls.push({ i, caller: meta.caller }); return ${answer}; } });
  return { async stop() {} };
} };`);
}

test("module: Planner add hands the words and kind to planner.add, and says what the planner kept", async t => {
  const dir = fakePlanner(path.join(tempHome(t), "mods"));
  const { reg } = await start(t, { modules: [dir] });
  const route = (await reg.call("apps.route", { text: "remind me to call juno at 6" }, "capsule")).data;
  assert.equal(route.app, "Planner");
  const r = await reg.call("apps.act", { app: route.app, action: route.action, args: route.args }, "capsule");
  assert.equal(r.data.said, "Reminder: call juno");
  assert.deepEqual(/** @type {any} */ (globalThis).__plannerCalls, [{ i: { text: "remind me to call juno at 6", kind: "reminder" }, caller: "module:apps" }]);
});

test("module: a planner answer with no words says planner.parse's reading, or the words", async t => {
  const now = Date.UTC(2026, 8, 24, 10, 0);
  const bare = fakePlanner(path.join(tempHome(t), "mods"), "{ id: 'itm_2', kind: 'timer', title: '' }");
  const { reg } = await start(t, { modules: [bare], apps: { now: () => now, timeZone: "Asia/Karachi" } });
  assert.equal((await reg.call("apps.act", { app: "Planner", action: "add", args: { text: "timer 10 min", kind: "timer" } }, "cli")).data.said, "Added to the planner: timer 10 min");
  const reading = parsingPlanner(path.join(tempHome(t), "mods2"));
  const two = await start(t, { modules: [reading], apps: { now: () => now, timeZone: "Asia/Karachi" } });
  assert.equal((await two.reg.call("apps.act", { app: "Planner", action: "add", args: { text: "timer 10 min", kind: "timer" } }, "cli")).data.said, "Timer for 10 minutes");
});

test("module: without a planner module, Planner add is code setup in words", async t => {
  const { reg } = await start(t);
  const r = await reg.call("apps.act", { app: "Planner", action: "add", args: { text: "todo buy milk", kind: "todo" } }, "cli");
  assert.deepEqual(r.error, { code: "setup", message: "The planner is not on this Vyre yet" });
});

/** A made-up WhatsApp with people to pick from, for the recipient questions. */
const whatsapp = (/** @type {any[]} */ sent = []) => ({
  id: "whatsapp", app: "WhatsApp", bundleIds: ["net.whatsapp.WhatsApp"], tier: "ax",
  actions: { send: { title: "Send", sends: true, input: { type: "object", required: ["to", "text"], properties: { to: { type: "string" }, text: { type: "string" } } },
    preview: (/** @type {any} */ a) => `WhatsApp → ${a.to}: ${a.text}`, run: async (/** @type {any} */ a) => { sent.push(a); return { said: `Sent to ${a.to}` }; } } },
  targets: async () => [
    { id: "c1", title: "Juno Park", kind: "contact" }, { id: "c2", title: "Jules", kind: "contact" },
    { id: "c3", title: "Ammi jee", kind: "contact" }, { id: "c4", title: "kit", kind: "contact" },
  ],
});

test("module: a message with no app is asked about, offering the apps Vyre sends through, then the installed ones", async t => {
  const { reg, home } = await start(t, { apps: { adapters: [whatsapp()] } });
  const dir = path.join(home, "Applications");
  fakeApp(dir, "Messages", "com.apple.MobileSMS");
  fakeApp(dir, "Telegram", "ru.keepcoder.Telegram");
  fakeApp(dir, "WhatsApp", "net.whatsapp.WhatsApp");
  fakeApp(dir, "Northwind Bakery POS", "com.example.pos");
  const r = (await reg.call("apps.route", { text: "tell juno I'm running late" }, "capsule")).data;
  assert.equal(r.ask, "Which app?");
  assert.equal(r.text, "I'm running late");
  assert.deepEqual(r.needs.app, [
    { name: "WhatsApp", bundleId: "net.whatsapp.WhatsApp", hint: "Vyre sends through it" },
    { name: "Messages", bundleId: "com.apple.MobileSMS", hint: "installed; Vyre cannot send through it yet" },
    { name: "Telegram", bundleId: "ru.keepcoder.Telegram", hint: "installed; Vyre cannot send through it yet" },
  ]);
});

test("module: an unclear recipient is asked about with fuzzy candidates, a lone strong one as Did you mean", async t => {
  const sent = /** @type {any[]} */ ([]);
  const { reg } = await start(t, { apps: { adapters: [whatsapp(sent)] } });
  const ask = async (/** @type {string} */ text) => (await reg.call("apps.route", { text }, "capsule")).data;

  const two = await ask("whatsapp ju: hi there");
  assert.deepEqual(two.needs.recipient.map((/** @type {any} */ c) => c.title), ["Jules", "Juno Park"]);
  assert.deepEqual(Object.keys(two.needs.recipient[0]).sort(), ["app", "id", "score", "title"]);
  assert.equal(two.didYouMean, undefined);
  assert.equal(two.text, "hi there");

  const one = await ask("whatsapp ammi: dinner at 8?");
  assert.equal(one.didYouMean, "Did you mean Ammi jee on WhatsApp?");
  assert.deepEqual(one.needs.recipient.map((/** @type {any} */ c) => c.id), ["c3"]);
  assert.equal(one.text, "dinner at 8?");

  const none = await ask("whatsapp zed: hi");
  assert.deepEqual(none.needs, { recipient: [] });
  assert.equal(none.ask, "Who should get this?");
  assert.equal(none.text, "hi");

  const exact = await ask("whatsapp kit: hi");
  assert.equal(exact.sends, true);
  assert.deepEqual(exact.args, { to: "kit", text: "hi" });
  assert.equal(sent.length, 0, "routing sent something");
});

test("module: a refused recipient sentence asks who on that app, with the words kept, even with no people to list", async t => {
  const { reg } = await start(t);
  const r = (await reg.call("apps.route", { text: "tell mom I'm on slack now" }, "capsule")).data;
  assert.deepEqual({ needs: r.needs, ask: r.ask, app: r.app, text: r.text, action: r.action },
    { needs: { recipient: [] }, ask: "Who should get this?", app: "Slack", text: "I'm on slack now", action: "send" });
});

test("module: a picked answer routes on with {text, app, to}, checked against the app's people", async t => {
  const sent = /** @type {any[]} */ ([]);
  const { reg } = await start(t, { apps: { adapters: [whatsapp(sent)] } });
  const ask = async (/** @type {any} */ input) => (await reg.call("apps.route", input, "capsule")).data;

  const ok = await ask({ text: "dinner at 8?", app: "WhatsApp", to: "Ammi jee" });
  assert.deepEqual({ sends: ok.sends, args: ok.args, said: ok.said }, { sends: true, args: { to: "Ammi jee", text: "dinner at 8?" }, said: "WhatsApp → Ammi jee: dinner at 8?" });

  const again = await ask({ text: "dinner at 8?", app: "whatsapp", to: "ammi" });
  assert.equal(again.didYouMean, "Did you mean Ammi jee on WhatsApp?", "a typed name not in the app is asked about again");

  const noApp = await ask({ text: "hi", to: "juno" });
  assert.equal(noApp.ask, "Which app?");
  assert.equal(noApp.to, "juno");

  const cannot = await ask({ text: "hi", app: "Messages", to: "juno" });
  assert.equal(cannot.ambiguous, true);
  assert.match(cannot.reason, /cannot send through Messages/);
  assert.equal(sent.length, 0, "routing sent something");
});

test("module: an answer by id is that person, two people with one name are asked about, and a bare first word is dropped only when it is someone", async t => {
  const sent = /** @type {any[]} */ ([]);
  const wa = whatsapp(sent);
  const twins = { ...wa, targets: async () => [...await wa.targets(), { id: "c5", title: "Alex", kind: "contact" }, { id: "c6", title: "Alex", kind: "contact" }] };
  const { reg } = await start(t, { apps: { adapters: [twins] } });
  const ask = async (/** @type {any} */ input) => (await reg.call("apps.route", input, "capsule")).data;

  const byId = await ask({ text: "dinner at 8?", app: "WhatsApp", to: "c3" });
  assert.deepEqual({ args: byId.args, said: byId.said }, { args: { to: "c3", text: "dinner at 8?" }, said: "WhatsApp → Ammi jee: dinner at 8?" });

  const two = await ask({ text: "whatsapp alex: hi" });
  assert.equal(two.ask, "Which one?");
  assert.deepEqual(two.needs.recipient.map((/** @type {any} */ c) => c.id), ["c5", "c6"]);

  const bare = await ask({ text: "whatsapp juno running late" });
  assert.equal(bare.to, "juno");
  assert.equal(bare.text, "running late", "juno is someone, so the message is the rest");
  assert.equal(bare.firstWordIsTo, undefined);
  const plain = await ask({ text: "whatsapp running late" });
  assert.equal(plain.text, "running late", "no one is called running, so the words stay whole");
  assert.equal(plain.to, undefined);
  assert.equal(sent.length, 0, "routing sent something");
});

test("module: Apple words inside a message stay in the message", async t => {
  const { reg } = await start(t, { apps: { adapters: [whatsapp()] } });
  const r = (await reg.call("apps.route", { text: "whatsapp kit: the code is in apple notes" }, "capsule")).data;
  assert.deepEqual({ app: r.app, args: r.args }, { app: "WhatsApp", args: { to: "kit", text: "the code is in apple notes" } });
  const tell = (await reg.call("apps.route", { text: "tell kit to check the notes app" }, "capsule")).data;
  assert.equal(tell.ask, "Which app?");
  assert.equal(tell.text, "to check the notes app");
  const note = (await reg.call("apps.route", { text: "note in apple notes: buy milk" }, "capsule")).data;
  assert.equal(note.app, "Notes");
});

test("module: apps.list says what Vyre can do in an app it has words for, and nothing for one it has not", async t => {
  const { reg, home } = await start(t, { apps: { adapters: [whatsapp()] } });
  const dir = path.join(home, "Applications");
  fakeApp(dir, "WhatsApp", "net.whatsapp.WhatsApp");
  fakeApp(dir, "Northwind Bakery POS", "com.example.pos");
  const rows = (await reg.call("apps.list", { limit: 100 }, "capsule")).data.apps;
  const wa = rows.find((/** @type {any} */ r) => r.name === "WhatsApp");
  assert.deepEqual({ actions: wa.actions, nests: wa.nests, tier: wa.tier }, { actions: ["send"], nests: true, tier: "ax" });
  const pos = rows.find((/** @type {any} */ r) => r.name === "Northwind Bakery POS");
  assert.equal(pos.actions, undefined);
  assert.equal(pos.nests, undefined);
});

/** A stand-in planner with planner.parse answering these words (ADR 0025's one time reader). */
function parsingPlanner(/** @type {string} */ root) {
  return writeModule(root, "planner", { roles: ["local"], does: { tools: ["planner.add", "planner.parse"] } }, `
const at = Date.UTC(2026, 8, 24, 13, 0);
const ANSWERS = {
  "timer 10 min": { kind: "timer", title: "Timer", at, tz: "Asia/Karachi", duration: 600000, duration_ms: 600000 },
  "remind me to call juno at 6": { kind: "reminder", title: "call juno", at, tz: "Asia/Karachi" },
  "alarm 6pm every weekday": { kind: "alarm", title: "Alarm", at, tz: "Asia/Karachi", wall: "18:00", repeat: { every: "weekday" } },
  "remind me at 6 to": { ambiguous: true, reason: "remind you of what?" },
  "remind me today at 9am to stretch": { ambiguous: true, reason: "that time has already passed today" },
};
export default { async start(ctx) {
  globalThis.__parseCalls = [];
  ctx.tool("planner.add", { input: { type: "object" }, async run(i) { return { id: "itm_1", kind: i.kind }; } });
  ctx.tool("planner.parse", { input: { type: "object" }, async run(i) { globalThis.__parseCalls.push(i); return ANSWERS[i.text] ?? null; } });
  return { async stop() {} };
} };`);
}

test("module: planner.parse reads the time; our rules pick the app; its refusal is the answer", async t => {
  const dir = parsingPlanner(path.join(tempHome(t), "mods"));
  const now = Date.UTC(2026, 8, 24, 10, 0);
  const { reg } = await start(t, { modules: [dir], apps: { now: () => now, timeZone: "Asia/Karachi" } });
  const ask = async (/** @type {string} */ text) => (await reg.call("apps.route", { text }, "capsule")).data;

  const timer = await ask("timer 10 min");
  assert.deepEqual({ app: timer.app, args: timer.args, said: timer.said }, { app: "Planner", args: { text: "timer 10 min", kind: "timer" }, said: "Timer for 10 minutes" });
  const rem = await ask("remind me to call juno at 6");
  assert.equal(rem.said, "Reminder: call juno, today at 18:00");
  const weekday = await ask("alarm 6pm every weekday");
  assert.equal(weekday.said, "Alarm every weekday at 18:00");
  const past = await ask("remind me today at 9am to stretch");
  assert.deepEqual(past, { ambiguous: true, reason: "that time has already passed today" }, "the planner's no is the answer");
  assert.deepEqual(/** @type {any} */ (globalThis).__parseCalls.map((/** @type {any} */ c) => c.kind), ["timer", "reminder", "alarm", "reminder"], "each with the kind our rules saw");

  // The Mac's own apps: the planner's reading becomes their args, without the Apple words.
  const clock = await ask("timer 10 min in apple clock");
  assert.deepEqual({ app: clock.app, args: clock.args }, { app: "Clock", args: { seconds: 600 } });
  assert.equal(/** @type {any} */ (globalThis).__parseCalls.at(-1).text, "timer 10 min");
  const remMac = await ask("remind me to call juno at 6 in apple reminders");
  assert.deepEqual({ app: remMac.app, args: remMac.args }, { app: "Reminders", args: { text: "call juno", due: "2026-09-24T18:00" } });
  const rep = await ask("alarm 6pm every weekday in apple clock");
  assert.equal(rep.ambiguous, true, "Apple Clock cannot keep a repeating alarm, so it is refused with a reason");
  assert.ok(rep.reason);

  // Words the planner cannot read keep the route; a message never asks it.
  const note = await ask("note: buy milk");
  assert.equal(note.said, "Note: buy milk");
  const before = /** @type {any} */ (globalThis).__parseCalls.length;
  await ask("whatsapp juno: running late");
  assert.equal(/** @type {any} */ (globalThis).__parseCalls.length, before);
});

test("module: with no planner.parse on this Vyre, a Mac app's time is code setup, never a guess", async t => {
  const now = Date.UTC(2026, 8, 24, 10, 0);
  const { reg } = await start(t, { apps: { now: () => now, timeZone: "Asia/Karachi" } });
  const r = await reg.call("apps.route", { text: "timer 10 min in apple clock" }, "capsule");
  assert.deepEqual(r.error, { code: "setup", message: "The planner is not on this Vyre yet" });
  const p = (await reg.call("apps.route", { text: "timer 10 min" }, "capsule")).data;
  assert.deepEqual({ app: p.app, args: p.args, said: p.said }, { app: "Planner", args: { text: "timer 10 min", kind: "timer" }, said: "Timer: timer 10 min" },
    "a Planner add stands: planner.add reads it, and says setup itself");
});
