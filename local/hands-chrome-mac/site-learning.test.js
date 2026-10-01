// @ts-check
// Site learning end to end, on by default (the user's ruling, 1 Oct 2026): the chrome module through the real Registry, a fake extension
// on a real socket, and the real memory and settings modules. The extension's site.put reaches memory.site.put through the module:
// on, the structure is stored and no canary is; off (the person's memory.site.learn setting), nothing is stored; and an agent caller
// is refused by memory.site.put itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discover, Registry } from "../../core/modules/index.js";
import { open } from "../../core/store/index.js";
import { Events } from "../../core/events/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeApp } from "../hands-mac/fake.js";
import { fakeExtension, until } from "./fake-extension.js";
import { controlId } from "./extension/lib/observe.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(path.dirname(path.dirname(HERE)), "core");
const HANDS = path.join(path.dirname(HERE), "hands-mac");
// Built from parts so no secret scanner reads this file as a key: the shape is what the redactor looks for.
const CANARY = ["sk", "live", "51NcanaryNOTREAL0000000000000000"].join("_");

async function rig(/** @type {any} */ t) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-sl-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  const f = fakeApp({ elements: [] });
  const reg = new Registry({ db, events: new Events(db), log: () => {}, paths: { root: home },
    config: { role: "local", hands: { runner: f.run, sleep: async () => {} }, chrome: { extensionOrigin: null, sockPath, nativeHost: null, floor: null, home: sockDir, platform: "darwin", hostDir: sockDir } } });
  const want = new Set(["chrome", "hands", "memory", "settings"]);
  const found = [...discover([path.dirname(HERE), CORE]).filter(m => want.has(String(m.manifest && m.manifest.name)) && (m.dir === HERE || m.dir === HANDS || m.dir.startsWith(CORE)))];
  await reg.start(found, { role: "local" });
  t.after(() => reg.stop && reg.stop());
  const x = await fakeExtension(sockPath, {});
  await until(async () => (await reg.call("chrome.status", {}, "cli")).data.connected);
  return { reg, x, db };
}

const patch = (/** @type {string} */ origin, /** @type {any[]} */ controls) => ({ key: origin, controls });
const good = { id: controlId("/workflows", { identifier: "save-workflow" }), page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "save-workflow" }, identifierVisits: ["v1", "v2"], outcome: "ok" };
const bad = { id: controlId("/workflows", { identifier: CANARY }), page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: CANARY }, identifierVisits: ["v1", "v2"], outcome: "ok" };

test("site learning, on by default: the structure is stored through the module and the registry, and no canary is", async t => {
  const { reg, x, db } = await rig(t);
  const origin = "https://app.example.com";
  await x.send({ event: "site.put", origin, patch: patch(origin, [good]) });
  await x.send({ event: "site.put", origin: "https://other.example.com", patch: patch("https://other.example.com", [bad]) });
  await until(async () => (await reg.call("memory.site.list", {}, "cli")).data.sites.some((/** @type {any} */ s) => s.origin === origin || s.key === origin));
  const got = (await reg.call("memory.site.detail", { key: origin }, "cli")).data;
  assert.equal(got.found, true);
  assert.equal(got.parts.controls.length, 1, "the structure is stored: one control");
  const other = (await reg.call("memory.site.detail", { key: "https://other.example.com" }, "cli")).data;
  assert.ok(!other.found || other.parts.controls.length === 0, "the secret-shaped control was not stored: " + JSON.stringify(db.prepare("SELECT key, record FROM memory_site WHERE key = ?").all("https://other.example.com")).slice(0, 700));
  const all = JSON.stringify([(await reg.call("memory.site.list", {}, "cli")).data, got, other]);
  assert.ok(!all.includes(CANARY), "no canary anywhere in the store's answers");
  const tables = /** @type {any[]} */ (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_site%'").all());
  for (const tb of tables) assert.ok(!JSON.stringify(db.prepare(`SELECT * FROM ${tb.name}`).all()).includes(CANARY), `nor in ${tb.name}`);
});

test("site learning, off: with memory.site.learn turned off nothing is stored, even for a good observation", async t => {
  const { reg, x } = await rig(t);
  const set = await reg.call("settings.set", { key: "memory.site.learn", value: false }, "cli");
  assert.ok(!set.error, JSON.stringify(set.error));
  const origin = "https://off.example.com";
  await x.send({ event: "site.put", origin, patch: patch(origin, [good]) });
  await new Promise(r => setTimeout(r, 400));
  const list = (await reg.call("memory.site.list", {}, "cli")).data.sites;
  assert.ok(!list.some((/** @type {any} */ s) => s.origin === origin || s.key === origin), "nothing stored while learning is off");
  // The store refuses too, whoever calls: the module is not the only gate.
  const direct = await reg.call("memory.site.put", { origin, target: "origin", patch: patch(origin, [good]) }, "cli");
  assert.equal(direct.data && direct.data.accepted, false);
});

test("an agent caller is refused by memory.site.put and memory.site.get", async t => {
  const { reg } = await rig(t);
  const origin = "https://agent.example.com";
  const put = await reg.call("memory.site.put", { origin, target: "origin", patch: patch(origin, [good]) }, "mcp:agent:kit");
  assert.ok(put.error, "an agent may not put");
  const get = await reg.call("memory.site.get", { origin }, "mcp:agent:kit");
  assert.ok(get.error, "nor read");
  const list = (await reg.call("memory.site.list", {}, "cli")).data.sites;
  assert.ok(!list.some((/** @type {any} */ s) => s.origin === origin || s.key === origin), "and nothing was stored");
});
