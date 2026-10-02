// @ts-check
// The phone's More sheet (js/more.js): the places that are not one of the four tabs, as a grid, with the
// account head. It is the Places sheet with the four tabs left out: the hold that pins a place as a page stays.

import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

async function load() {
  const { install, text, $, $$ } = await import("./fake-dom.js");
  install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const mod = await import("../js/more.js");
  return { ...mod, text, $, $$ };
}

test("more: the tiles are Planner, Memory, Vault, Drive, Devices, Settings, none a tab", async () => {
  const { MORE } = await load();
  assert.deepEqual(MORE.map(t => t.label), ["Planner", "Memory", "Vault", "Drive", "Devices", "Settings"]);
  assert.deepEqual(MORE.map(t => t.href), ["/planner", "/memory", "/vault", "/files", "/settings#devices", "/settings"]);
  for (const tab of ["Now", "Chat", "Agents", "Projects"]) assert.ok(!MORE.some(t => t.label === tab), `${tab} is a tab`);
});

test("more: the head names the person and your server; a tap closes the sheet and opens the place; a hold pins it as a page", async () => {
  const lib = await load();
  const body = document.createElement("div"), head = document.createElement("div"), sheet = document.createElement("div");
  const opened = /** @type {string[]} */ ([]);
  let closed = 0, stopped = 0;
  const r = lib.fillMore(body, () => { closed++; }, { head, sheet }, { name: "alex", letter: "A", host: "vyre.harlow.ts.net",
    open: t => opened.push(t.href), health: fn => { fn({ path: "direct" }); return () => { stopped++; }; }, line: () => "direct, 12 ms" });
  assert.ok(sheet.classList.contains("sheet-more"));
  assert.equal(lib.$(head, ".plc-name").textContent, "alex");
  assert.equal(lib.$(head, ".plc-where").textContent, "vyre.harlow.ts.net · direct, 12 ms");
  assert.equal(r.tiles.length, 6);
  assert.equal(lib.$(body, ".plc-hint").textContent, "Long-press a tile to pin it as a page.");
  const vault = /** @type {any} */ (lib.$(body, "a[data-place=Vault]"));
  vault.dispatchEvent(Object.assign(new Event("click"), { button: 0 }));
  assert.deepEqual([opened, closed], [["/vault"], 1]);
  r.stop();
  assert.equal(stopped, 1);
});

test("the phone keeps the hold-to-pin page, with no sixth tab: the kept place is a swipe page, More says where you are, and its tile leads More", async () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, "../js/app.js"), "utf8");
  assert.match(app, /\{ const kept = readPin\(\); if \(kept\) strip\.push\(fifth\(kept\)\); \}/);
  assert.match(app, /pinned: keep,/);
  assert.match(app, /const phLabels = PAGER\.map\(tab\);/, "four tabs, whatever is kept");
  assert.match(app, /moreTab\.setAttribute\("aria-current", "page"\)/);
  const lib = await load();
  const store = { v: /** @type {string | null} */ ("/vault"), getItem() { return this.v; }, setItem(/** @type {string} */ _k, /** @type {string} */ v) { this.v = v; }, removeItem() { this.v = null; } };
  const body = document.createElement("div"), head = document.createElement("div"), sheet = document.createElement("div");
  const r = lib.fillMore(body, () => {}, { head, sheet }, { open: () => {}, store });
  assert.equal(r.tiles[0].getAttribute("data-place"), "Vault", "the kept place is the first tile");
  assert.ok(r.tiles[0].hasAttribute("data-kept"), "marked as pinned");
  assert.equal(r.tiles.length, 6);
});
