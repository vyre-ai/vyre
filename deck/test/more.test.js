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

test("more: the head names the person and the box; a tap closes the sheet and opens the place; a hold pins it as a page", async () => {
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

test("the phone keeps the hold-to-pin page: the kept place is read at start, joins the pager and the tab bar, and More's holds change it", () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, "../js/app.js"), "utf8");
  assert.match(app, /\{ const kept = readPin\(\); if \(kept\) strip\.push\(fifth\(kept\)\); \}/);
  assert.match(app, /pinned: keep,/);
  assert.match(app, /tabBar\.insertBefore\(phLabels\[N\], moreTab\)/);
  assert.match(fs.readFileSync(path.join(import.meta.dirname, "../css/tabbar.css"), "utf8"), /\.tabbar\[data-tabs="6"\] \{ grid-template-columns: repeat\(6/);
});
