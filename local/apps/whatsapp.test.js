// @ts-check
// WhatsApp over the hands (slice 4), in a Registry with the real apps and hands modules and a
// fake WhatsApp window (hands' own fakeApp): no screen, no real app, nothing ever sent anywhere.
// The fake behaves like the app: the search field filters the chat list, pressing a row opens
// that chat with its name above a message field, and pressing Send (only through hands.commit)
// records the words and empties the field.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp as fakeWindow } from "../hands-mac/fake.js";
import { fakeExec, fakeApp as installApp } from "./fake.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HANDS = path.join(HERE, "..", "hands-mac");
const nosleep = async () => {};

const at = (/** @type {number} */ y) => ({ x: 0, y, w: 300, h: 40 });

/**
 * A WhatsApp window: `chats` in the list; `opens` says which chat a row really opens (a wrong
 * one tests the check); `takes` false makes the message field ignore what is set.
 * `switchTo` moves the open chat to another once the words are set (a person clicking elsewhere).
 * @param {string[]} chats @param {{ opens?: (name: string) => string, takes?: boolean, switchTo?: string }} [o]
 */
function whatsappWindow(chats, { opens = n => n, takes = true, switchTo = "" } = {}) {
  /** @type {{ to: string, text: string }[]} */
  const sent = [];
  const search = { path: "/0/s", role: "AXTextField", name: "Search", value: "", enabled: true, frame: at(0) };
  const rows = () => chats.filter(n => !search.value || n.toLowerCase().includes(search.value.toLowerCase()))
    .map((n, i) => ({ path: `/0/r${i}`, role: "AXCell", name: n, enabled: true, frame: at(50 + i * 40) }));
  /** @type {any} */
  const state = { app: "WhatsApp", bundle: "net.whatsapp.WhatsApp", window: "WhatsApp", front: false, elements: [], texts: [], open: null };
  const draw = () => {
    state.elements = [search, ...rows(), ...(state.open ? [
      { path: "/1/h", role: "AXStaticText", name: state.open, enabled: true, frame: { x: 320, y: 0, w: 400, h: 40 } },
      { path: "/1/c", role: "AXTextArea", name: "Type a message", value: state.draft || "", enabled: true, frame: { x: 320, y: 900, w: 600, h: 40 } },
      { path: "/1/b", role: "AXButton", name: "Send", enabled: true, frame: { x: 930, y: 900, w: 40, h: 40 } },
    ] : [])];
  };
  draw();
  const f = fakeWindow(state, (/** @type {any} */ req) => {
    if (req.path === "/0/s" && req.kind === "set") search.value = req.value;
    else if (req.path.startsWith("/0/r") && req.kind === "press") { state.open = opens(String(req.name)); state.draft = ""; }
    else if (req.path === "/1/c" && req.kind === "set") { if (takes) state.draft = req.value; if (switchTo && req.value) { state.open = switchTo; } }
    else if (req.path === "/1/b" && req.kind === "press") { sent.push({ to: state.open, text: state.draft }); state.texts = [...state.texts, state.draft]; state.draft = ""; }
    draw();
    return { acted: true };
  });
  return { ...f, sent, state };
}

async function start(/** @type {any} */ t, /** @type {ReturnType<typeof whatsappWindow>} */ w) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const apps = path.join(home, "Applications");
  installApp(apps, "WhatsApp", "net.whatsapp.WhatsApp");
  const f = fakeExec(() => ({}));
  const reg = new Registry({ db, events: new Events(db), log: () => {},
    config: { role: "local", hands: { runner: w.run, sleep: nosleep }, apps: { exec: f.exec, platform: "darwin", tmpdir: home, dirs: [apps], fetch: async () => { throw new Error("no network in tests"); } } } });
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE || m.dir === HANDS), { role: "local" });
  t.after(() => reg.stop());
  return reg;
}

const acts = (/** @type {any} */ w) => w.calls.filter((/** @type {any} */ c) => c.cmd === "act").map((/** @type {any} */ c) => `${c.kind} ${c.name}`);

test("whatsapp: search, open the one chat, check it, write, press Send once, and see it go", async t => {
  const w = whatsappWindow(["Harlow Legal", "juno", "Juno Park"]);
  const reg = await start(t, w);
  const r = await reg.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "running late\nsorry" } }, "cli");
  assert.ifError(r.error);
  assert.deepEqual(r.data, { said: "Sent to juno on WhatsApp", verified: true });
  assert.deepEqual(w.sent, [{ to: "juno", text: "running late\nsorry" }]);
  assert.deepEqual(acts(w), ["set Search", "press juno", "set Type a message", "press Send"], "never a key: no Return, nothing typed");
  assert.equal(w.state.front, false, "WhatsApp was never raised");
});

test("whatsapp: two chats that could be it, or none, are a question, and nothing is written", async t => {
  const two = whatsappWindow(["Alex", "Alex", "juno"]);
  const reg = await start(t, two);
  const r = await reg.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "alex", text: "hi" } }, "cli");
  assert.equal(r.error.code, "ambiguous");
  assert.deepEqual(two.sent, []);
  assert.deepEqual(acts(two), ["set Search"]);

  const none = whatsappWindow(["Juno Park", "juno's bakery"]);
  const reg2 = await start(t, none);
  const n = await reg2.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" } }, "cli");
  assert.equal(n.error.code, "not_found");
  assert.match(n.error.message, /no chat called exactly juno \(it has Juno Park, juno's bakery\)/);
  assert.deepEqual(none.sent, []);
});

test("whatsapp: a chat that opens as someone else, or a field that will not take the words, stops before Send", async t => {
  const wrong = whatsappWindow(["juno", "kit"], { opens: () => "kit" });
  const reg = await start(t, wrong);
  const r = await reg.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" } }, "cli");
  assert.equal(r.error.code, "failed");
  assert.match(r.error.message, /could not confirm the open chat is juno; nothing was written/);
  assert.deepEqual(acts(wrong), ["set Search", "press juno"]);

  const stuck = whatsappWindow(["juno"], { takes: false });
  const reg2 = await start(t, stuck);
  const s = await reg2.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" } }, "cli");
  assert.equal(s.error.code, "failed");
  assert.deepEqual(stuck.sent, []);
  assert.equal(acts(stuck).includes("press Send"), false);
  assert.equal(acts(stuck).at(-1), "set Type a message", "the field is cleared again after a stop");
});

test("whatsapp: the chat is checked again right before Send; another chat opened in between gets nothing", async t => {
  const w = whatsappWindow(["juno", "kit"], { switchTo: "kit" });
  const reg = await start(t, w);
  const r = await reg.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "running late" } }, "cli");
  assert.equal(r.error.code, "failed");
  assert.match(r.error.message, /no longer juno; nothing was sent/);
  assert.deepEqual(w.sent, []);
  assert.equal(acts(w).includes("press Send"), false);
  assert.equal(acts(w).at(-1), "set Type a message", "the words are taken back out");
});

test("whatsapp: apps.act refuses a send, and a stop from the person holds every later step", async t => {
  const w = whatsappWindow(["juno"]);
  const reg = await start(t, w);
  assert.equal((await reg.call("apps.act", { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" } }, "cli")).error.code, "sends");
  await reg.call("hands.stop", {}, "cli");
  const r = await reg.call("apps.send", { app: "WhatsApp", action: "send", args: { to: "juno", text: "hi" } }, "cli");
  assert.equal(r.error.code, "stopped");
  assert.deepEqual(w.sent, []);
});

test("whatsapp: the chats on screen are its targets, words route to it, and a name off screen still goes to the search", async t => {
  const w = whatsappWindow(["Harlow Legal", "juno", "Northwind Bakery"]);
  const reg = await start(t, w);
  assert.deepEqual((await reg.call("apps.targets", { app: "WhatsApp", q: "nor" }, "cli")).data.targets, [{ id: "Northwind Bakery", title: "Northwind Bakery", kind: "chat" }]);
  const r = (await reg.call("apps.route", { text: "whatsapp juno: running late" }, "capsule")).data;
  assert.deepEqual({ app: r.app, args: r.args, sends: r.sends, said: r.said, gated: r.gated }, { app: "WhatsApp", args: { to: "juno", text: "running late" }, sends: true, said: "WhatsApp → juno: running late", gated: undefined });
  const off = (await reg.call("apps.route", { text: "whatsapp kit: on my way" }, "capsule")).data;
  assert.deepEqual({ app: off.app, args: off.args, ambiguous: off.ambiguous }, { app: "WhatsApp", args: { to: "kit", text: "on my way" }, ambiguous: undefined });
  assert.equal(w.sent.length, 0, "routing and listing send nothing");
  assert.deepEqual(acts(w), [], "and act on nothing");
});
