// @ts-check
// The floor, the hold, the commit, the stop: everything that decides whether an act happens at
// all, driven with a fake app and a fake overlay so no screen is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Hands } from "./hands.js";
import { HandsError } from "./runner.js";
import { makeOverlay, center } from "./overlay.js";
import mod from "./index.js";
import { discover, Registry } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp, fakeOverlay } from "./fake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nosleep = async () => {};
const code = (/** @type {string} */ c) => (/** @type {any} */ e) => e instanceof HandsError && e.code === c;

const composer = (extra = {}) => ({
  app: "Messages", bundle: "com.apple.MobileSMS", window: "juno", texts: ["hi"],
  elements: [
    { path: "/0/0", role: "AXTextArea", name: "Message", value: "", enabled: true, frame: { x: 100, y: 200, w: 300, h: 40 } },
    { path: "/0/1", role: "AXButton", name: "Send", enabled: true, frame: { x: 420, y: 200, w: 60, h: 40 } },
    { path: "/0/2", role: "AXButton", name: "Attach", enabled: true },
    { path: "/0/3", role: "AXTextField", name: "Password", secure: true, enabled: true },
  ],
  ...extra,
});
const counts = (/** @type {any[]} */ calls, /** @type {string} */ cmd) => calls.filter(c => c.cmd === cmd).length;

// ---------------------------------------------------------------- the floor

test("floor: a password manager is untouchable, and observe does not even read it", async () => {
  const f = fakeApp(composer({ app: "1Password", bundle: "com.1password.1password", window: "Vault" }));
  const h = new Hands({ run: f.run, sleep: nosleep });
  const o = await h.observe({});
  assert.deepEqual(o, { app: "1Password", pid: 4242, window: "Vault", blind: "a password manager", elements: [], texts: [], truncated: false });
  await assert.rejects(h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" }), e => code("floor")(e) && /password manager/.test(e.message));
  assert.equal(counts(f.calls, "snap"), 0, "the untouchable place was read");
  assert.equal(counts(f.calls, "act"), 0);
});

test("floor: the Deck in a browser is off limits by the box's origin, which comes from the link", async () => {
  const f = fakeApp(composer({ app: "Safari", bundle: "com.apple.Safari", window: "Vault", origin: "https://box.tailnet-juno.ts.net" }));
  const h = new Hands({ run: f.run, sleep: nosleep, known: async () => ({ box: "https://box.tailnet-juno.ts.net/" }) });
  assert.equal((await h.observe({})).blind, "a Vyre surface in the browser");
  const other = new Hands({ run: fakeApp(composer({ bundle: "com.apple.Safari", origin: "https://northwind.example" })).run, known: async () => ({ box: "https://box.tailnet-juno.ts.net" }) });
  assert.equal((await other.observe({})).blind, undefined, "an ordinary page was blinded");
});

test("floor: the module asks link.status for the box, and no link module means no box", async () => {
  const tools = new Map();
  /** @type {any[]} */ const asked = [];
  const f = fakeApp(composer({ bundle: "com.apple.Safari", origin: "https://box.tailnet-juno.ts.net" }));
  const ctx = (/** @type {any} */ answer) => ({
    config: { hands: { runner: f.run, sleep: nosleep } }, events: { emit() {} },
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ tool) => { asked.push(tool); return answer; },
  });
  await mod.start(ctx({ data: { linked: true, box: { address: "https://box.tailnet-juno.ts.net" } } }));
  assert.equal((await tools.get("hands.observe").run({})).blind, "a Vyre surface in the browser");
  assert.deepEqual(asked, ["link.status"]);
  tools.clear();
  await mod.start(ctx({ error: { code: "no_such_tool", message: "no tool link.status" } }));
  assert.equal((await tools.get("hands.observe").run({})).blind, undefined);
});

test("floor: a window that turns guarded between the two looks is refused on what was read", async () => {
  const f = fakeApp({ app: "System Settings", bundle: "com.apple.systempreferences", window: "Wi-Fi", elements: [{ path: "/0/0", role: "AXButton", name: "Allow", enabled: true }] });
  const run = async (/** @type {any} */ req) => { const r = await f.run(req); if (req.cmd === "where") f.state.window = "Privacy & Security"; return r; };
  await assert.rejects(new Hands({ run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "Allow" }, kind: "press" }), code("floor"));
  assert.equal(counts(f.calls, "act"), 0);
});

test("secure: a password field is refused for every kind, pointing at vault.fill", async () => {
  const f = fakeApp(composer());
  const h = new Hands({ run: f.run, sleep: nosleep });
  for (const kind of ["type", "set", "focus", "press"]) {
    await assert.rejects(h.act({ selector: { role: "AXTextField", name: "Password" }, kind, value: "hunter2" }),
      e => code("secure")(e) && /vault\.fill/.test(e.message) && !e.message.includes("hunter2"));
  }
  assert.equal(counts(f.calls, "act"), 0);
});

// ---------------------------------------------------------------- outward acts are held

test("outward: Send is held, not pressed, and the answer says to use hands.commit", async () => {
  const events = [];
  const f = fakeApp(composer(), (req, s) => { s.texts = ["sent"]; return { acted: true }; });
  const ov = fakeOverlay();
  const h = new Hands({ run: f.run, sleep: nosleep, overlay: ov, emit: (t, p) => events.push([t, p]) });
  const r = await h.act({ selector: { role: "AXButton", name: "Send" }, kind: "press" });
  assert.deepEqual([r.acted, r.verified, r.held, r.use], [false, false, true, "hands.commit"]);
  assert.match(r.reason, /sends something as you.*hands\.commit/);
  assert.equal(counts(f.calls, "act"), 0);
  assert.equal(ov.sent.length, 0, "a held act showed the indicator");
  assert.equal(events[0][1].held, true);
  // Return in a chat, and a line break typed into one, are held the same way.
  assert.equal((await h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "key", key: "return" })).held, true);
  assert.equal((await h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "type", value: "see you\n" })).held, true);
  // Confirming a Send button is pressing it.
  f.state.elements[1].actions = ["AXPress", "AXConfirm"];
  assert.equal((await h.act({ selector: { role: "AXButton", name: "Send" }, kind: "action", action: "AXConfirm" })).held, true);
  assert.equal(counts(f.calls, "act"), 0);
});

test("outward: the commit path acts, and never skips the untouchable check", async () => {
  const f = fakeApp(composer(), (req, s) => { s.texts = ["sent"]; return { acted: true }; });
  const r = await new Hands({ run: f.run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "Send" }, kind: "press" }, { commit: true });
  assert.equal(r.verified, true);
  const g = fakeApp(composer({ bundle: "com.apple.keychainaccess" }));
  await assert.rejects(new Hands({ run: g.run, sleep: nosleep }).act({ selector: { role: "AXButton", name: "Send" }, kind: "press" }, { commit: true }), code("floor"));
  assert.equal(counts(g.calls, "act"), 0);
});

test("commit: through the Registry it is marked presence, refused without proof, and done with it", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp(composer(), (req, s) => { s.texts = ["sent"]; return { acted: true }; });
  let allow = false;
  /** @type {string[]} */ const shown = [];
  const presence = {
    required: (/** @type {string} */ tool, /** @type {any} */ def) => Boolean(def && def.presence),
    verify: async (/** @type {any} */ { def, input }) => {
      shown.push(await def.presence.summary(input));
      return allow ? { ok: true, method: "tty" } : { ok: false, message: "a person has to allow this", methods: ["tty"] };
    },
    challenge: async () => ({}),
  };
  const reg = new Registry({ db, events: new Events(db), log: () => {}, presence,
    config: { role: "local", hands: { runner: f.run, sleep: nosleep, overlay: fakeOverlay() } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  const listed = Object.fromEntries(reg.listTools().map(x => [x.name, x]));
  assert.equal(listed["hands.commit"].presence, true);
  assert.equal(listed["hands.act"].presence, undefined);

  const input = { selector: { role: "AXButton", name: "Send" }, kind: "press" };
  const held = await reg.call("hands.act", input, "mcp");
  assert.equal(held.data.held, true);
  const refused = await reg.call("hands.commit", input, "mcp");
  assert.equal(refused.error?.code, "presence_required");
  assert.equal(counts(f.calls, "act"), 0, "commit acted without a person");
  assert.equal(shown[0], `Press "Send" in Messages, window "juno"`);

  allow = true;
  const done = await reg.call("hands.commit", input, "mcp");
  assert.equal(done.data?.verified, true, JSON.stringify(done));
  assert.equal(counts(f.calls, "act"), 1);
});

test("commit: the summary names what is sent, where, and survives a failed look", async () => {
  const f = fakeApp(composer());
  const h = new Hands({ run: f.run });
  assert.equal(await h.summary({ kind: "type", value: "see you at seven", selector: { role: "AXTextArea", name: "Message" } }), `Type "see you at seven" into "Message" in Messages, window "juno"`);
  assert.equal(await h.summary({ kind: "key", key: "return", modifiers: ["cmd"], selector: { role: "AXTextArea", name: "Message" } }), `Press Cmd-Return in "Message" in Messages, window "juno"`);
  const broken = new Hands({ run: async () => { throw new HandsError("no_app", "gone"); } });
  assert.equal(await broken.summary({ kind: "press", app: "Mail", selector: { role: "AXButton", name: "Send" } }), `Press "Send" in Mail`);
});

// ---------------------------------------------------------------- the stop

test("stop: the stop keys mid-settle end the act at once, with no further look", async () => {
  const events = [];
  const f = fakeApp(composer());   // accepts the press and changes nothing, so the settle loop keeps looking
  const ov = fakeOverlay();
  let sleeps = 0;
  const sleep = async () => { if (++sleeps === 2) ov.pressStop(); };
  const h = new Hands({ run: f.run, sleep, overlay: ov, emit: (t, p) => events.push([t, p]) });
  const r = await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press", settleMs: 5000 });
  assert.equal(r.stopped, true);
  assert.equal(r.acted, true);
  assert.equal(r.verified, false);
  assert.match(r.reason, /stopped by the person.*not verified/);
  assert.equal(sleeps, 2, "the settle loop kept going after the stop");
  assert.equal(counts(f.calls, "snap"), 2, "it looked again after the stop");
  assert.deepEqual(events.find(e => e[0] === "hands.stopped")?.[1], { app: "Messages", by: "person" });
  assert.ok(ov.sent.some(m => m.done), "the indicator was not told the session is over");
  assert.ok(!ov.sent.some(m => m.ring), "a ring was drawn for an act that was cut short");
});

test("stop: a stop while the sleep is pending does not wait the sleep out", async () => {
  const f = fakeApp(composer());
  const ov = fakeOverlay();
  const sleep = () => new Promise(r => setTimeout(r, 10000).unref());
  const h = new Hands({ run: f.run, sleep, overlay: ov });
  const t0 = Date.now();
  setTimeout(() => ov.pressStop(), 30);
  const r = await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press", settleMs: 20000 });
  assert.equal(r.stopped, true);
  assert.ok(Date.now() - t0 < 2000, "the act slept through the stop");
});

test("stop: later acts are refused until one passes resume: true", async () => {
  const events = [];
  const f = fakeApp(composer(), (req, s) => { s.texts = [String(Math.random())]; return { acted: true }; });
  const ov = fakeOverlay();
  const h = new Hands({ run: f.run, sleep: nosleep, overlay: ov, emit: (t, p) => events.push([t, p]) });
  await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" });
  ov.pressStop();
  ov.pressStop();   // twice is one stop
  assert.equal(events.filter(e => e[0] === "hands.stopped").length, 1);
  const before = counts(f.calls, "act"), looked = f.calls.length;
  await assert.rejects(h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" }), e => code("stopped")(e) && /resume: true/.test(e.message));
  await assert.rejects(h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" }, { commit: true }), code("stopped"));
  assert.equal(counts(f.calls, "act"), before);
  assert.equal(f.calls.length, looked, "a stopped act still looked at the screen");
  const r = await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press", resume: true });
  assert.equal(r.verified, true);
  assert.deepEqual(events.find(e => e[0] === "hands.resumed")?.[1], { app: "Messages" });
  // Resumed means resumed: the next act needs no flag.
  assert.equal((await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" })).verified, true);
});

test("stop: hands.stop through the Registry stops, and the next act is refused with code stopped", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp(composer(), (req, s) => { s.texts = ["x"]; return { acted: true }; });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: nosleep, overlay: fakeOverlay() } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  const input = { selector: { role: "AXButton", name: "Attach" }, kind: "press" };
  await reg.call("hands.act", input, "mcp");
  assert.deepEqual((await reg.call("hands.stop", {}, "mcp")).data, { stopped: true, app: "Messages", by: "tool" });
  const refused = await reg.call("hands.act", input, "mcp");
  assert.equal(refused.error?.code, "stopped");
  assert.equal((await reg.call("hands.act", { ...input, resume: true }, "mcp")).data?.acted, true);
  const types = reg.deps.events.since(0).map(e => e.type);
  assert.ok(types.includes("hands.stopped") && types.includes("hands.resumed"), types.join(","));
});

// ---------------------------------------------------------------- the overlay

test("overlay: the indicator comes up before the act and the ring lands on the control's centre", async () => {
  const f = fakeApp(composer(), (req, s) => { s.texts = ["x"]; return { acted: true }; });
  const ov = fakeOverlay();
  const order = [];
  const run = async (/** @type {any} */ req) => { order.push(req.cmd); return f.run(req); };
  const orig = ov.controlling.bind(ov);
  ov.controlling = async (app, at) => { order.push("controlling"); return orig(app, at); };
  const h = new Hands({ run, sleep: nosleep, overlay: ov });
  await h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "focus" });
  assert.deepEqual(order.slice(0, 4), ["where", "snap", "controlling", "act"]);
  assert.deepEqual(ov.sent[0], { controlling: { app: "Messages", x: 250, y: 220 } });
  // Focus is never observed on this fake, so the ring is red: not verified.
  assert.deepEqual(ov.sent[1], { ring: { x: 250, y: 220, ok: false } });
  await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" });
  assert.ok(!ov.sent.slice(2).some(m => m.ring), "a control with no frame got a ring at a made-up point");
});

test("overlay: no indicator means no act", async () => {
  const f = fakeApp(composer());
  const ov = fakeOverlay();
  ov.controlling = async () => { throw new HandsError("no_indicator", "the control indicator is not built"); };
  await assert.rejects(new Hands({ run: f.run, sleep: nosleep, overlay: ov }).act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" }), code("no_indicator"));
  assert.equal(counts(f.calls, "act"), 0);
});

test("overlay: centre of a frame, in the frame's own top-left points", () => {
  assert.deepEqual(center({ x: 100, y: 200, w: 300, h: 41 }), { x: 250, y: 221 });
  assert.deepEqual(center({ x: -1920, y: -300, w: 40, h: 20 }), { x: -1900, y: -290 }, "a display left of and above the primary");
  assert.equal(center({ x: 0, y: 0, w: 0, h: 10 }), null);
  assert.equal(center(undefined), null);
});

/** A child process stand-in: what Node writes to it, and what it says back. */
function fakeHelper({ keys = true, ready = true } = {}) {
  /** @type {string[]} */ const got = [];
  /** @type {any} */ let child;
  const spawn = (/** @type {string} */ bin, /** @type {string[]} */ args) => {
    const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), pid: 777, args, kill() { c.emit("exit", null); } });
    child = c;
    c.stdin.on("data", (/** @type {Buffer} */ d) => got.push(...String(d).split("\n").filter(Boolean)));
    c.stdin.on("finish", () => setImmediate(() => c.emit("exit", 0)));
    if (ready) setImmediate(() => c.stdout.write(JSON.stringify({ ready: true, keys }) + "\n"));
    return c;
  };
  return { spawn: /** @type {any} */ (spawn), got, child: () => child };
}

test("overlay: the helper protocol, NDJSON both ways", async () => {
  const fh = fakeHelper();
  const ov = makeOverlay({ bin: fileURLToPath(import.meta.url), spawn: fh.spawn, platform: "darwin", linger: 8 });
  let stops = 0;
  ov.onStop(() => stops++);
  await ov.controlling("Notes", { x: 10, y: 20 });
  ov.ring({ x: 10, y: 20, ok: true });
  ov.ring({ x: 11, y: 21, ok: false });
  assert.deepEqual(fh.child().args, ["--linger", "8"]);
  fh.child().stdout.write('{"stop":true}\n');
  await new Promise(r => setImmediate(r));
  assert.equal(stops, 1);
  ov.done();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(fh.got.map(l => JSON.parse(l)), [
    { controlling: { app: "Notes", x: 10, y: 20 } },
    { ring: { x: 10, y: 20, ok: true } },
    { ring: { x: 11, y: 21, ok: false } },
    { done: true },
  ]);
  assert.equal(ov.pid(), null, "done did not let go of the helper");
  // The next act starts a fresh helper rather than writing to the one that is leaving.
  await ov.controlling("Notes");
  assert.equal(ov.pid(), 777);
  ov.close();
});

test("overlay: refuses with no_indicator when it cannot show or cannot hear the stop keys", async () => {
  const bin = fileURLToPath(import.meta.url);
  await assert.rejects(makeOverlay({ bin: path.join(HERE, "no-such-overlay"), platform: "darwin" }).controlling("Notes"), e => code("no_indicator")(e) && /build\.sh/.test(e.message));
  await assert.rejects(makeOverlay({ bin, platform: "linux" }).controlling("Notes"), code("no_indicator"));
  await assert.rejects(makeOverlay({ bin, platform: "darwin", spawn: fakeHelper({ keys: false }).spawn }).controlling("Notes"), e => code("no_indicator")(e) && /stop keys/.test(e.message));
  await assert.rejects(makeOverlay({ bin, platform: "darwin", readyMs: 50, spawn: fakeHelper({ ready: false }).spawn }).controlling("Notes"), e => code("no_indicator")(e) && /did not start/.test(e.message));
});

// ---------------------------------------------------------------- accessibility actions

test("action: performed only when the control offers it, and verified by its own rule", async () => {
  const f = fakeApp({ elements: [{ path: "/0/0", role: "AXIncrementor", name: "Copies", value: "1", enabled: true, actions: ["AXIncrement", "AXDecrement"] }] },
    (req, s) => { if (req.action === "AXIncrement") s.elements[0].value = String(Number(s.elements[0].value) + 1); return { acted: true }; });
  const h = new Hands({ run: f.run, sleep: nosleep });
  const up = await h.act({ selector: { role: "AXIncrementor", name: "Copies" }, kind: "action", action: "AXIncrement" });
  assert.equal(up.verified, true, up.reason);
  assert.equal(f.calls.find(c => c.cmd === "act").action, "AXIncrement");
  const down = await h.act({ selector: { role: "AXIncrementor", name: "Copies" }, kind: "action", action: "AXDecrement" });
  assert.equal(down.verified, false);
  assert.match(down.reason, /did not change/);
  const no = await h.act({ selector: { role: "AXIncrementor", name: "Copies" }, kind: "action", action: "AXShowMenu" });
  assert.equal(no.acted, false);
  assert.match(no.reason, /does not offer AXShowMenu/);
  await assert.rejects(h.act({ selector: { role: "AXIncrementor" }, kind: "action", action: "AXDelete" }), /action must be one of/);
  assert.equal(counts(f.calls, "act"), 2);
});

test("act: pinned to the observed pid and bundle, and a helper that finds another owner is a miss", async () => {
  const f = fakeApp(composer());
  const run = async (/** @type {any} */ req) => {
    if (req.cmd === "act") { f.calls.push(req); throw new HandsError("not_owner", "pid 4242 now belongs to another app; nothing was done"); }
    return f.run(req);
  };
  const r = await new Hands({ run, sleep: nosleep }).act({ app: "Messages", selector: { role: "AXButton", name: "Attach" }, kind: "press" });
  assert.deepEqual([r.acted, r.verified], [false, false]);
  assert.match(r.reason, /nothing was done/);
  const req = f.calls.find(c => c.cmd === "act");
  assert.equal(req.pid, 4242);
  assert.equal(req.bundle, "com.apple.MobileSMS");
  assert.equal(req.app, undefined, "the act went by name, not by the pinned pid");
});

// ---------------------------------------------------------------- find, settle, background

/** A chat app with more controls than the default cap: the rows past 120 must still be findable. */
const chats = () => {
  const elements = [];
  for (let i = 0; i < 150; i++) elements.push({ path: `/0/r${i}`, role: "AXRow", name: i === 140 ? "juno" : `chat ${i}`, enabled: true, frame: { x: 0, y: i * 40, w: 300, h: 40 } });
  elements.push({ path: "/0/s", role: "AXTextField", name: "Search", identifier: "chat-search", value: "juno", enabled: true, frame: { x: 0, y: -40, w: 300, h: 30 } });
  elements.push({ path: "/0/c", role: "AXTextArea", name: "Compose message", enabled: true, frame: { x: 320, y: 900, w: 600, h: 40 } });
  elements.push({ path: "/0/b", role: "AXButton", name: "Send", enabled: true, frame: { x: 930, y: 900, w: 40, h: 40 } });
  elements.push({ path: "/0/b2", role: "AXButton", name: "Send voice note", enabled: true, frame: { x: 0, y: 2000, w: 40, h: 40 } });
  return { app: "WhatsApp", bundle: "net.whatsapp.WhatsApp", window: "WhatsApp", front: false, elements };
};

test("find: match reads past the default cap, filters by role and label, and orders by near", async () => {
  const f = fakeApp(chats());
  const h = new Hands({ run: f.run, sleep: nosleep });
  const row = await h.observe({ app: "net.whatsapp.WhatsApp", match: { role: "Row", name: "JUNO" } });
  assert.deepEqual(row.elements.map(e => e.selector.name), ["juno"]);
  assert.equal(f.calls.at(-1).limit, 500, "a filtered observe reads up to 500 controls");
  assert.equal(row.front, false);
  // Label or identifier, never the value: the search field's value "juno" does not make it a match.
  assert.deepEqual((await h.observe({ match: { name: "chat-search" } })).elements.map(e => e.selector.path), ["/0/s"]);
  assert.equal((await h.observe({ match: { role: "AXTextField", name: "juno" } })).elements.length, 0);
  // near: the Send beside the composer comes before the voice note button.
  const send = await h.observe({ match: { role: "AXButton", name: "send", near: "Compose message" } });
  assert.deepEqual(send.elements.map(e => e.selector.name), ["Send", "Send voice note"]);
  // limit caps the matches and truncated says so.
  const some = await h.observe({ match: { role: "AXRow", limit: 5 } });
  assert.equal(some.elements.length, 5);
  assert.equal(some.truncated, true);
});

test("find: hands.find through the Registry returns only the matches, and the floor still blinds", async t => {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const f = fakeApp(chats());
  const reg = new Registry({ db, events: new Events(db), log: () => {}, config: { role: "local", hands: { runner: f.run, sleep: nosleep } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  const r = await reg.call("hands.find", { app: "net.whatsapp.WhatsApp", role: "AXTextArea" }, "module");
  assert.ifError(r.error);
  assert.deepEqual(r.data.elements.map(e => e.selector.name), ["Compose message"]);
  assert.equal(r.data.texts, undefined);
  f.state.bundle = "com.1password.1password"; f.state.app = "1Password";
  const b = await reg.call("hands.find", { role: "AXTextArea" }, "module");
  assert.ok(b.data.blind);
  assert.deepEqual(b.data.elements, []);
});

test("settle: settleMs is clamped to 5000, and the default stays 1500", async () => {
  const waited = async (/** @type {number | undefined} */ settleMs) => {
    let slept = 0;
    const f = fakeApp(composer(), () => ({ acted: true }));
    await new Hands({ run: f.run, sleep: async ms => { slept += ms; } }).act({ selector: { role: "AXButton", name: "Attach" }, kind: "press", ...(settleMs === undefined ? {} : { settleMs }) });
    return slept;
  };
  assert.equal(await waited(undefined), 1500);
  assert.equal(await waited(4000), 4000);
  assert.equal(await waited(60000), 5000);
  assert.equal(await waited(-5), 0);
});

test("background: press, set and type act without raising; a key is refused with needs_front, held or committed", async () => {
  const f = fakeApp(composer({ front: false }), (req, s) => { if (req.kind === "set" || req.kind === "type") s.elements[0].value = req.value; else s.texts = ["pressed"]; return { acted: true }; });
  const h = new Hands({ run: f.run, sleep: nosleep });
  assert.equal((await h.act({ selector: { role: "AXButton", name: "Attach" }, kind: "press" })).verified, true);
  assert.equal((await h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "set", value: "see you at seven" })).verified, true);
  // Return in a chat would be held; in the background it is refused first, so no proof is asked for a key that cannot land.
  await assert.rejects(h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "key", key: "return" }), code("needs_front"));
  await assert.rejects(h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "key", key: "return" }, { commit: true }), code("needs_front"));
  assert.equal(f.calls.filter(c => c.cmd === "act" && c.kind === "key").length, 0, "a key was posted to an app in the background");
  // Nothing in any request asks the helper to raise or activate the app.
  assert.equal(f.calls.some(c => c.action === "AXRaise" || c.activate), false);
  // In front, the same key is allowed (held, because Return in a chat sends).
  f.state.front = true;
  assert.equal((await h.act({ selector: { role: "AXTextArea", name: "Message" }, kind: "key", key: "return" })).held, true);
});

test("background: the fake helper refuses a key to an app in the background, as the real one does", async () => {
  const f = fakeApp(composer({ front: false }));
  await assert.rejects(f.run({ cmd: "act", pid: 4242, path: "/0/0", role: "AXTextArea", kind: "key", key: "tab" }), code("needs_front"));
});
