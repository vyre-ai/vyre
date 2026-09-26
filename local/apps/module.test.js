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
import { tempHome } from "../../test/helpers.js";
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
async function start(t, { apps = {}, presence = false } = {}) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const events = new Events(db);
  const p = presence ? new Presence({ db, events, platform: "linux", touchid: null, webauthn: null, who: async () => [], writeTty: () => {} }) : undefined;
  const f = fakeExec(() => ({}));
  const reg = new Registry({ db, events, log: () => {}, presence: p,
    config: { role: "local", apps: { exec: f.exec, platform: "darwin", tmpdir: home, dirs: [path.join(home, "Applications")], fetch: async () => { throw new Error("no network in tests"); }, ...apps } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  t.after(() => reg.stop());
  return { reg, home, calls: f.calls, events: () => reg.deps.events.since(0) };
}

test("module: the manifest is valid under the loader's rules", () => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
});

test("module: starts in the Registry, registers the four tools, and starting runs nothing", async t => {
  const { reg, calls } = await start(t);
  assert.equal(reg.status().find(m => m.name === "apps")?.state, "running");
  assert.deepEqual(reg.listTools().map(x => x.name).sort(), ["apps.act", "apps.list", "apps.send", "apps.targets"]);
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
  const other = await presence.verify({ tool: "gate.approve", input: {}, caller: "capsule", proof, def: { presence: { session: () => true } } });
  assert.equal(other.ok, false);
  assert.match(other.message, /needs its own proof/);
  assert.equal(chat.sent.length, 2);
});
