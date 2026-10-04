// @ts-check
// The side view against a fake vyre-tile: the real runner process handling, the layout applied in
// order, close putting every frame back, the floor, Glass, and the module through the Registry.
// No window is read or moved and no app is launched.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry, validate } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { makeTile } from "./runner.js";
import { Sideview } from "./sideview.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-tile.js");

const TERMINAL = { pid: 10, bundle: "com.apple.Terminal", app: "Terminal", index: 0, title: "vyre-test", frame: { x: 200, y: 100, w: 700, h: 500 }, minimized: false, standard: true, z: 0 };
const CHROME = { pid: 20, bundle: "com.google.Chrome", app: "Google Chrome", index: 0, title: "vyre-test", frame: { x: 600, y: 80, w: 1000, h: 900 }, minimized: false, standard: true, z: 1 };
const SCREEN = { frame: { x: 0, y: 0, w: 1800, h: 1170 }, visible: { x: 0, y: 33, w: 1800, h: 1060 } };

/** A fake tile and the file its windows live in. */
function fake(t, scenario = {}) {
  const state = tempHome(t);
  const log = path.join(state, "requests.jsonl");
  const tile = makeTile({ bin: FAKE, platform: "darwin", responsible: () => "Terminal", env: { ...process.env, FAKE_TILE: JSON.stringify({ state, log, front: { pid: 10, bundle: "com.apple.Terminal" }, screens: [SCREEN], windows: [TERMINAL, CHROME], ...scenario }) } });
  const file = path.join(state, "windows.json");
  const windows = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : (scenario.windows || [TERMINAL, CHROME]);
  const requests = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  // Written whole, then renamed: the fake tile may read the file at the same moment.
  const add = w => { fs.writeFileSync(file + ".tmp", JSON.stringify([...windows(), w])); fs.renameSync(file + ".tmp", file); };
  return { tile, windows, requests, add };
}

test("open: the session takes 29% on the left, Chrome the rest, and close puts both back", async t => {
  const f = fake(t);
  const v = new Sideview({ tile: f.tile, launch: async () => { throw new Error("no launch expected"); } });
  const r = await v.open();
  assert.deepEqual(r.left.frame, { x: 0, y: 33, w: 522, h: 1060 });
  assert.deepEqual(r.right.frame, { x: 522, y: 33, w: 1278, h: 1060 });
  assert.equal(r.left.app, "Terminal");
  assert.equal(r.exact, true);
  // Left first, then right, each its own set; nothing activated under tests.
  const sets = f.requests().filter(q => q.cmd === "set");
  assert.deepEqual(sets.map(q => q.moves[0].pid), [10, 20]);
  assert.deepEqual(sets[1].activate, []);
  assert.equal(v.status().open, true);

  // A second open does not overwrite the frames to go back to.
  await v.open({ ratio: 0.4 });
  const c = await v.close();
  assert.equal(c.restored, 2);
  assert.deepEqual(f.windows().map(w => w.frame), [TERMINAL.frame, CHROME.frame]);
  assert.deepEqual(v.status(), { open: false });
  assert.deepEqual(await v.close(), { open: false, restored: 0 });
});

test("open: a session app that will not get narrow pushes Chrome over instead of under it", async t => {
  const f = fake(t, { minWidth: { "10": 700 } });
  const r = await new Sideview({ tile: f.tile }).open();
  assert.equal(r.left.frame.w, 700);
  assert.deepEqual(r.right.frame, { x: 700, y: 33, w: 1100, h: 1060 });
  assert.equal(r.exact, false);
});

test("open: with no Chrome window it asks for one and waits for it; a url goes to Chrome", async t => {
  const f = fake(t, { windows: [TERMINAL] });
  /** @type {(string|null)[]} */
  const launched = [];
  const v = new Sideview({ tile: f.tile, stepMs: 10, launch: async url => { launched.push(url); setTimeout(() => f.add(CHROME), 30); } });
  const r = await v.open();
  assert.deepEqual(launched, [null]);
  assert.equal(r.right.bundle, "com.google.Chrome");
  await v.open({ url: "https://example.com/a" });
  assert.deepEqual(launched, [null, "https://example.com/a"]);
});

test("open: Chrome that never shows a window is a failure with words, not a hang", async t => {
  const f = fake(t, { windows: [TERMINAL] });
  const v = new Sideview({ tile: f.tile, waitMs: 60, stepMs: 10, launch: async () => {} });
  await assert.rejects(v.open(), e => e.code === "no_browser");
});

test("open: under tests the real launcher refuses, so no app is ever opened", async t => {
  const f = fake(t, { windows: [TERMINAL] });
  await assert.rejects(new Sideview({ tile: f.tile }).open(), e => e.code === "no_dialog");
});

test("open: no terminal, a floor app, and bad input are refused with words", async t => {
  const f = fake(t, { front: { pid: 20, bundle: "com.google.Chrome" }, windows: [CHROME, { ...TERMINAL, pid: 30, bundle: "com.1password.1password", app: "1Password" }] });
  const v = new Sideview({ tile: f.tile });
  await assert.rejects(v.open(), e => e.code === "no_session");
  await assert.rejects(v.open({ session: { bundle: "com.1password.1password" } }), e => e.code === "floor" && /password manager/.test(e.message));
  await assert.rejects(v.open({ url: "javascript:alert(1)" }), e => e.code === "bad_input");
  await assert.rejects(v.open({ browser: "safari" }), e => e.code === "bad_input");
  await assert.rejects(v.open({ session: "left" }), e => e.code === "bad_input");
  // Nothing was moved by any of them.
  assert.equal(f.requests().filter(q => q.cmd === "set").length, 0);
});

test("open: Glass needs a paired box and opens its page for the agent named", async t => {
  const f = fake(t);
  /** @type {(string|null)[]} */
  const launched = [];
  let linked = false;
  const call = async tool => tool === "link.status" ? { data: linked ? { linked: true, box: { address: "https://juno.example.ts.net" } } : { linked: false } } : {};
  const v = new Sideview({ tile: f.tile, call, launch: async url => { launched.push(url); } });
  await assert.rejects(v.open({ browser: "glass" }), e => e.code === "no_box" && /vyre link pair/.test(e.message));
  linked = true;
  await v.open({ browser: "glass" });
  await v.open({ browser: "glass", glass: "kit" });
  assert.deepEqual(launched, ["https://juno.example.ts.net/glass/box", "https://juno.example.ts.net/glass/kit"]);
  await assert.rejects(v.open({ browser: "glass", glass: "../x" }), e => e.code === "bad_input");
  await assert.rejects(v.open({ browser: "glass", url: "https://example.com" }), e => e.code === "bad_input");
});

test("runner: no grant, not built and not macOS come back as codes with words that say what to do", async t => {
  const f = fake(t, { notTrusted: true });
  await assert.rejects(new Sideview({ tile: f.tile }).open(), e => e.code === "not_trusted" && e.message === "grant Accessibility to Terminal in System Settings > Privacy & Security > Accessibility");
  await assert.rejects(makeTile({ bin: path.join(HERE, "no-such-helper"), platform: "darwin" }).request({ cmd: "trust" }), e => e.code === "not_built" && /build\.sh/.test(e.message));
  await assert.rejects(makeTile({ bin: FAKE, platform: "linux" }).request({ cmd: "trust" }), e => e.code === "unsupported");
});

async function registry(t, sideview) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  /** @type {string[]} */
  const logged = [];
  const reg = new Registry({ db, events: new Events(db), log: (m, x) => { logged.push(JSON.stringify([m, x ?? null])); }, config: { role: "local", sideview } });
  t.after(() => reg.stop());
  await reg.start(discover([path.dirname(HERE)]).filter(m => m.dir === HERE), { role: "local" });
  return { reg, logged };
}

test("module: valid manifest, three tools, local callers only, and no titles in the log or events", async t => {
  assert.deepEqual(validate(JSON.parse(fs.readFileSync(path.join(HERE, "module.json"), "utf8"))), []);
  const f = fake(t, { windows: [{ ...TERMINAL, title: "private-title" }, CHROME] });
  const { reg, logged } = await registry(t, { tile: f.tile });
  assert.equal(reg.status().find(m => m.name === "sideview")?.state, "running");
  assert.deepEqual(reg.listTools("mcp").map(x => x.name).sort(), ["sideview.close", "sideview.open", "sideview.status"]);
  const r = await reg.call("sideview.open", {}, "cli");
  assert.equal(r.data.left.frame.w, 522, JSON.stringify(r));
  assert.equal((await reg.call("sideview.status", {}, "mcp")).data.open, true);
  assert.equal((await reg.call("sideview.open", {}, "mcp", { peer: { node: "juno", user: "alex" } })).error?.code, "local_only");
  assert.equal((await reg.call("sideview.open", {}, "hook")).error?.code, "no_such_tool");
  assert.equal((await reg.call("sideview.close", {}, "cli")).data.restored, 2);
  assert.equal(logged.join("\n").includes("private-title"), false);
  assert.equal(JSON.stringify(reg.deps.events.since(0)).includes("private-title"), false);
});

test("open with panel: only Chrome moves, fitted from the panel's right edge, and close restores only Chrome", async t => {
  const f = fake(t);
  const v = new Sideview({ tile: f.tile, launch: async () => { throw new Error("no launch expected"); } });
  const panel = { x: 0, y: 33, w: 522, h: 1060 };
  const r = await v.open({ panel });
  assert.deepEqual(r.left.frame, panel);
  assert.equal(r.left.app, "Vyre");
  assert.deepEqual(r.right.frame, { x: 522, y: 33, w: 1278, h: 1060 });
  const sets = f.requests().filter(q => q.cmd === "set");
  assert.deepEqual(sets.map(q => q.moves.map(m => m.pid)), [[20]]);
  assert.deepEqual(f.windows()[0].frame, TERMINAL.frame);
  const c = await v.close();
  assert.equal(c.restored, 1);
  assert.deepEqual(f.windows().map(w => w.frame), [TERMINAL.frame, CHROME.frame]);
  await assert.rejects(v.open({ panel: { x: 0, y: 0, w: 10, h: 10 } }), e => e.code === "bad_input");
  await assert.rejects(v.open({ panel, session: "front" }), e => e.code === "bad_input");
});
