// @ts-check
// The Places sheet from the phone's avatar (docs/design/system/components/phone-shell.md, anatomy
// 5 and "Pinned fourth page"): js/places.js fills js/sheet.js's sheet, js/app.js keeps the chosen
// place as a fourth page of the pager. The tiles, their order and routes, the hold and its
// keyboard path, the one kept place and where it is stored.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

async function load() {
  const { install, text, $, $$ } = await import("./fake-dom.js");
  install();
  // icons.js parses its drawings with DOMParser, and sheet.js draws its close glyph with
  // createElementNS; the fake DOM has neither.
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const mod = await import("../js/places.js");
  return { ...mod, text, $, $$ };
}

/** A localStorage stand-in. */
function memory() {
  const m = new Map();
  return { m, getItem: (/** @type {string} */ k) => m.has(k) ? m.get(k) : null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, String(v)); },
    removeItem: (/** @type {string} */ k) => { m.delete(k); } };
}

/** An open sheet's parts, and a Places sheet drawn in them. */
async function draw(/** @type {Record<string, any>} */ o = {}) {
  const lib = await load();
  const body = document.createElement("div"), head = document.createElement("div"), sheet = document.createElement("div");
  const opened = /** @type {any[]} */ ([]), kept = /** @type {any[]} */ ([]);
  let closed = 0;
  const store = o.store || memory();
  const r = lib.fillPlaces(body, () => { closed++; }, { head, sheet }, { name: "alex", letter: "A", host: "vyre.harlow.ts.net", store, hold: 5,
    open: t => opened.push(t.href), pinned: t => kept.push(t?.href ?? null), ...o });
  const tile = (/** @type {string} */ label) => /** @type {any} */ (lib.$(body, `a[data-place=${label}]`));
  return { ...lib, ...r, body, head, sheet, store, opened, kept, tile, closed: () => closed };
}

const ev = (/** @type {string} */ type, /** @type {Record<string, any>} */ props = {}) => Object.assign(new Event(type), { button: 0, clientX: 10, clientY: 10, pointerId: 1, ...props });

test("places: the seven tiles in the spec's order, the rail's routes, no page among them", async () => {
  const { TILES } = await load();
  assert.deepEqual(TILES.map(t => t.label), ["Projects", "Planner", "Memory", "Vault", "Drive", "Devices", "Settings"]);
  assert.deepEqual(TILES.map(t => t.href), ["/projects", "/planner", "/memory", "/vault", "/files", "/settings#devices", "/settings"]);
  assert.deepEqual(TILES.map(t => t.icon), ["projects", "planner", "memory", "vault", "drive", "devices", "settings"]);
  const { PLACES } = await import("../js/rail.js");
  for (const t of TILES) { const p = PLACES.find(q => q.label === t.label); if (p) assert.equal(p.href, t.href, `${t.label} goes where the rail goes`); }
});

test("places: the head (avatar, name, address), a grid of seven links named by their labels, the hint", async () => {
  const d = await draw();
  assert.ok(d.sheet.classList.contains("sheet-places"));
  assert.equal(d.$(d.head, ".plc-avatar").textContent, "A");
  assert.equal(d.$(d.head, ".plc-avatar").getAttribute("aria-hidden"), "true");
  assert.equal(d.$(d.head, ".plc-name").textContent, "alex");
  assert.equal(d.$(d.head, ".plc-where").textContent, "vyre.harlow.ts.net");
  assert.equal(d.$(d.head, "button.sheet-close").getAttribute("aria-label"), "Close");
  const grid = d.$(d.body, ".plc-grid");
  assert.equal(grid.getAttribute("aria-label"), "Places");
  const tiles = d.$$(grid, "a.plc-tile");
  assert.equal(tiles.length, 7);
  assert.deepEqual(tiles.map((/** @type {any} */ a) => d.$(a, ".plc-label").textContent), ["Projects", "Planner", "Memory", "Vault", "Drive", "Devices", "Settings"]);
  assert.deepEqual(tiles.map((/** @type {any} */ a) => a.getAttribute("href")), ["/projects", "/planner", "/memory", "/vault", "/files", "/settings#devices", "/settings"]);
  for (const a of tiles) {
    assert.ok(d.$(a, "svg"), "an icon over the label");
    assert.equal(a.getAttribute("aria-description"), "Long-press to pin as a page");
  }
  assert.equal(d.$(d.body, ".plc-hint").textContent, "Long-press a tile to pin it as a page.");
  // No owner name yet: the head still names the account.
  const n = await draw({ name: null });
  assert.equal(n.$(n.head, ".plc-name").textContent, "Account");
});

test("places: a tap closes the sheet and opens the place; a modified click is left to the browser", async () => {
  const d = await draw();
  await d.tile("Planner").click();
  assert.deepEqual(d.opened, ["/planner"]);
  assert.equal(d.closed(), 1);
  await d.tile("Devices").click();
  assert.deepEqual(d.opened, ["/planner", "/settings#devices"]);
  const e = ev("click", { metaKey: true });
  d.tile("Vault").dispatchEvent(e);
  assert.equal(e.defaultPrevented, false);
  assert.deepEqual(d.opened, ["/planner", "/settings#devices"]);
});

test("places: Shift+F10 or the context menu key keeps the place, again lets it go, and it is kept in vyre.pin", async () => {
  const d = await draw();
  const f10 = ev("keydown", { key: "F10", shiftKey: true });
  d.tile("Planner").dispatchEvent(f10);
  assert.equal(f10.defaultPrevented, true);
  assert.equal(d.store.getItem("vyre.pin"), "/planner");
  assert.deepEqual(d.kept, ["/planner"]);
  assert.equal(d.tile("Planner").getAttribute("aria-description"), "Pinned as a page");
  assert.ok(d.tile("Planner").hasAttribute("data-kept"));
  assert.equal(d.readPin(d.store)?.label, "Planner");
  assert.deepEqual(d.opened, [], "keeping a place does not open it");
  d.tile("Planner").dispatchEvent(ev("keydown", { key: "ContextMenu" }));
  assert.equal(d.store.getItem("vyre.pin"), null);
  assert.deepEqual(d.kept, ["/planner", null]);
  assert.equal(d.tile("Planner").getAttribute("aria-description"), "Long-press to pin as a page");
  // F10 alone is not the hold.
  d.tile("Planner").dispatchEvent(ev("keydown", { key: "F10" }));
  assert.equal(d.store.getItem("vyre.pin"), null);
});

test("places: one kept place at most: a new one replaces the old, and the sheet says so on both", async () => {
  const d = await draw();
  d.tile("Memory").dispatchEvent(ev("keydown", { key: "ContextMenu" }));
  d.tile("Vault").dispatchEvent(ev("keydown", { key: "ContextMenu" }));
  assert.equal(d.store.getItem("vyre.pin"), "/vault");
  assert.deepEqual(d.kept, ["/memory", "/vault"]);
  assert.equal(d.tile("Memory").getAttribute("aria-description"), "Long-press to pin as a page");
  assert.equal(d.tile("Vault").getAttribute("aria-description"), "Pinned as a page");
  assert.equal(d.$$(d.body, "a[data-kept]").length, 1);
  // A sheet opened later reads what this device kept.
  const again = await draw({ store: d.store });
  assert.equal(again.tile("Vault").getAttribute("aria-description"), "Pinned as a page");
});

test("places: a hold of the set time keeps the place and its click opens nothing; lifting early is a tap", async () => {
  const d = await draw();
  const t = d.tile("Projects");
  t.dispatchEvent(ev("pointerdown"));
  assert.ok(t.classList.contains("holding"));
  await sleep(25);
  assert.equal(d.store.getItem("vyre.pin"), "/projects");
  t.dispatchEvent(ev("pointerup"));
  await t.click();
  assert.deepEqual(d.opened, [], "the click that ends the hold does not open Projects");
  assert.equal(d.closed(), 0);
  // A short press: no keep, and the click opens it.
  t.dispatchEvent(ev("pointerdown"));
  t.dispatchEvent(ev("pointerup"));
  await sleep(25);
  assert.equal(d.store.getItem("vyre.pin"), "/projects", "unchanged");
  await t.click();
  assert.deepEqual(d.opened, ["/projects"]);
  // A finger that moves is scrolling, not holding.
  const m = d.tile("Memory");
  m.dispatchEvent(ev("pointerdown"));
  m.dispatchEvent(ev("pointermove", { clientX: 40 }));
  await sleep(25);
  assert.equal(d.store.getItem("vyre.pin"), "/projects");
  // The browser's own long-press (contextmenu) is the same hold, never twice for one press.
  const v = d.tile("Vault");
  v.dispatchEvent(ev("pointerdown"));
  await sleep(25);
  const cm = ev("contextmenu");
  v.dispatchEvent(cm);
  assert.equal(cm.defaultPrevented, true);
  assert.equal(d.store.getItem("vyre.pin"), "/vault");
  assert.deepEqual(d.kept, ["/projects", "/vault"]);
});

test("places: stored junk reads as none; storage that throws never breaks the sheet", async () => {
  const lib = await load();
  const s = memory();
  s.setItem("vyre.pin", "/now");
  assert.equal(lib.readPin(s), null, "a page is never a kept place");
  s.setItem("vyre.pin", "not a place");
  assert.equal(lib.readPin(s), null);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  assert.equal(lib.readPin(broken), null);
  assert.equal(lib.writePin("/planner", broken)?.label, "Planner", "the choice holds for this visit");
  const d = await draw({ store: broken });
  d.tile("Planner").dispatchEvent(ev("keydown", { key: "ContextMenu" }));
  assert.deepEqual(d.kept, ["/planner"]);
});

test("places: the path to your server joins the address only when link.health knows it", async () => {
  /** @type {(x: any) => void} */ let push = () => {};
  let stopped = 0;
  const d = await draw({ health: (/** @type {any} */ fn) => { push = fn; return () => { stopped++; }; }, line: (/** @type {any} */ x) => `${x.path} ${x.latencyMs} ms` });
  const where = d.$(d.head, ".plc-where");
  push(null);
  assert.equal(where.textContent, "vyre.harlow.ts.net");
  push({ path: "unknown", why: "no link" });
  assert.equal(where.textContent, "vyre.harlow.ts.net");
  push({ path: "direct", latencyMs: 12 });
  assert.equal(where.textContent, "vyre.harlow.ts.net · direct 12 ms");
  d.stop();
  assert.equal(stopped, 1, "the sheet stops asking when it closes");
});

test("places: js/places.js is the one list of places; the phone's More sheet reads it, and the sheet geometry holds", () => {
  const app = read("js/app.js"), sheet = read("css/sheet.css");
  assert.match(app, /class: "ph-avatar", "aria-label": "More and account"[^\n]*onclick: \(\) => openMore\(\)/);
  assert.doesNotMatch(app, /openSettings|Settings and account/, "no Settings sheet left; Settings is a tile");
  assert.match(read("js/more.js"), /import \{ TILES, fillPlaces \} from "\.\/places\.js"/, "no second copy of the list");
  // The sheet's geometry from the spec.
  assert.match(sheet, /\.sheet-places \.sheet-head \{ padding: 12px 16px 8px; \}/);
  assert.match(sheet, /\.plc-grid \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: 8px; \}/);
  assert.match(sheet, /\.plc-tile \{[^}]*min-height: 44px; padding: 12px;[^}]*border: 1px solid var\(--rule\); border-radius: 10px/);
  assert.match(sheet, /\.plc-label \{ font-size: 13px/);
  assert.match(sheet, /\.plc-name \{ font-size: 17px; line-height: 22px; font-weight: 600/);
  assert.match(sheet, /\.plc-where \{ font-size: 12px; line-height: 16px; color: var\(--label\)/);
  assert.match(sheet, /\.plc-hint \{[^}]*font-size: 12px; line-height: 16px; color: var\(--label\)/);
  assert.match(read("sw.js"), /"\/js\/places\.js"/, "kept at install");
});
