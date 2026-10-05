// @ts-check
// The rail from 720 px up (docs/design/system/components/rail.md): js/rail.js builds it, js/app.js
// mounts it left of the header, css/deck.css draws it 72 wide. Order, labels, names, the Now
// badge, the Cmd+number keys and the CSS geometry.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(DECK, f), "utf8");
const noComments = (/** @type {string} */ css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** Every rule body whose selector list names sel exactly (as written, e.g. ".rail-place"). */
const rules = (/** @type {string} */ css, /** @type {string} */ sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s,(>])${esc}(?![\\w-])`);
  return [...noComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => re.test(m[1])).map(m => ({ sel: m[1].trim(), body: m[2] }));
};
const decl = (/** @type {string} */ css, /** @type {string} */ sel, /** @type {RegExp} */ want) =>
  assert.ok(rules(css, sel).some(r => want.test(r.body)), `${sel} has ${want}`);

async function load() {
  const { install, $, $$ } = await import("./fake-dom.js");
  install();
  // icons.js parses its drawings with DOMParser, which the fake DOM does not have.
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  const mod = await import("../js/rail.js");
  return { ...mod, $, $$ };
}

test("rail: the places in the spec's order and words, the bottom group last, keys 1 to 8", async () => {
  const { PLACES } = await load();
  assert.deepEqual(PLACES.map(p => p.label), ["Now", "Chat", "Projects", "Agents", "Memory", "Vault", "Settings"]);
  assert.deepEqual(PLACES.map(p => p.key), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.deepEqual(PLACES.filter(p => p.end).map(p => p.label), ["Settings"]);
  assert.deepEqual(PLACES.map(p => p.href), ["/now", "/chat", "/projects", "/agents", "/memory", "/vault", "/settings"]);
  for (const p of PLACES) assert.doesNotMatch(p.label, /^(Home|Inbox|Dashboard|Sessions|Threads)$|^[A-Z]{2,}$/);
});

test("rail: nav named Vyre, the home mark to Now, links named by their labels, the avatar named Account", async () => {
  const { rail, $, $$ } = await load();
  const r = rail();
  assert.equal(r.el.tagName, "NAV");
  assert.equal(r.el.getAttribute("aria-label"), "Vyre");
  assert.equal(r.home.getAttribute("href"), "/now");
  assert.equal(r.home.getAttribute("aria-label"), "Vyre home");
  const places = $$(r.el, ".rail-place");
  assert.deepEqual(places.map((/** @type {any} */ a) => $(a, ".rail-label").textContent), ["Now", "Chat", "Projects", "Agents", "Memory", "Vault", "Search", "Settings"]);
  // The top group, then the bottom group with the avatar last.
  const groups = $$(r.el, ".rail-set");
  assert.equal(groups.length, 2);
  assert.equal($$(groups[0], "a.rail-place").length, 6);
  assert.ok(groups[1].className.includes("rail-end"));
  assert.equal(r.search.getAttribute("aria-label"), "Search");
  assert.equal(groups[1].childNodes.at(-1), r.avatar);
  assert.equal(r.avatar.getAttribute("href"), "/settings");
  assert.equal(r.avatar.getAttribute("aria-label"), "Account");
  assert.equal(r.avatar.getAttribute("title"), "Account");
  r.setOwner("alex", "A");
  assert.equal(r.avatar.getAttribute("title"), "alex");
  assert.equal($(r.avatar, ".rail-initial").textContent, "A");
  r.setOwner(null, "V");
  assert.equal(r.avatar.getAttribute("title"), "Account");
});

test("rail: Now carries the 18 badge (aria-hidden), reads 'Now, 5 need you', and the mark's dot follows", async () => {
  const { rail, nowLabel, $ } = await load();
  const r = rail();
  const now = r.links[0];
  const b = $(now, ".sm-badge");
  assert.equal(b, r.count, "the one badge from js/status-mark.js, not a second one");
  assert.equal(b.hidden, true);
  assert.equal(now.getAttribute("aria-label"), null, "no count: the visible label names it");
  r.setNeeds(5);
  assert.equal(b.hidden, false);
  assert.equal(b.textContent, "5");
  assert.equal(b.getAttribute("aria-hidden"), "true");
  assert.equal(now.getAttribute("aria-label"), "Now, 5 need you");
  assert.equal(r.el.getAttribute("data-needs"), "");
  r.setNeeds(1);
  assert.equal(now.getAttribute("aria-label"), "Now, 1 needs you");
  r.setNeeds(128);
  assert.equal(b.textContent, "99+");
  assert.equal(now.getAttribute("aria-label"), "Now, more than 99 need you");
  r.setNeeds(0);
  assert.equal(b.hidden, true);
  assert.equal(now.getAttribute("aria-label"), null);
  assert.equal(r.el.getAttribute("data-needs"), null);
  assert.equal(nowLabel(0), "Now");
  // Only Now has a badge.
  for (const a of r.links.slice(1)) assert.equal($(a, ".sm-badge"), null);
});

test("rail: one current place, aria-current page; needs is Now, Glass is Agents, Settings#devices is Settings", async () => {
  const { rail, placeOf } = await load();
  const r = rail();
  const current = () => r.links.filter((/** @type {any} */ a) => a.getAttribute("aria-current") === "page").map((/** @type {any} */ a) => a.getAttribute("data-place"));
  r.setCurrent("chat");
  assert.deepEqual(current(), ["Chat"]);
  r.setCurrent("needs");
  assert.deepEqual(current(), ["Now"]);
  r.setCurrent("glass");
  assert.deepEqual(current(), ["Agents"]);
  r.setCurrent("settings", "#devices");
  assert.deepEqual(current(), ["Settings"], "Devices is a part of Settings");
  r.setCurrent("settings", "#appearance");
  assert.deepEqual(current(), ["Settings"]);
  r.setCurrent("planner");
  assert.deepEqual(current(), ["Now"], "Planner is folded into Now");
  r.setCurrent("missing");
  assert.deepEqual(current(), []);
  assert.equal(placeOf("find"), null);
});

test("rail keys: Cmd+1 to Cmd+9 on a Mac, Ctrl off it, in rail order; never while typing", async () => {
  const { placeForKey, macKeys } = await load();
  const div = document.createElement("div");
  const k = (/** @type {string} */ key, /** @type {any} */ o = {}) => ({ key, target: div, ...o });
  assert.equal(placeForKey(k("1", { metaKey: true }), true), "/now");
  assert.equal(placeForKey(k("2", { metaKey: true }), true), "/chat");
  assert.equal(placeForKey(k("3", { metaKey: true }), true), "/projects");
  assert.equal(placeForKey(k("7", { metaKey: true }), true), "/settings");
  assert.equal(placeForKey(k("9", { metaKey: true }), true), null);
  assert.equal(placeForKey(k("4", { ctrlKey: true }), false), "/agents");
  assert.equal(placeForKey(k("6", { ctrlKey: true }), false), "/vault");
  // The other platform's modifier, extra modifiers, other keys, and a press already taken.
  assert.equal(placeForKey(k("1", { ctrlKey: true }), true), null);
  assert.equal(placeForKey(k("1", { metaKey: true }), false), null);
  assert.equal(placeForKey(k("1", { metaKey: true, shiftKey: true }), true), null);
  assert.equal(placeForKey(k("1", { metaKey: true, altKey: true }), true), null);
  assert.equal(placeForKey(k("0", { metaKey: true }), true), null);
  assert.equal(placeForKey(k("k", { metaKey: true }), true), null);
  assert.equal(placeForKey(k("1"), true), null);
  assert.equal(placeForKey(k("1", { metaKey: true, defaultPrevented: true }), true), null);
  // Typing: fields, and anything inside an editable region.
  for (const tag of ["input", "textarea", "select"]) assert.equal(placeForKey(k("1", { metaKey: true, target: document.createElement(tag) }), true), null, tag);
  const ed = document.createElement("div"); ed.setAttribute("contenteditable", "true");
  const inner = document.createElement("span"); ed.append(inner);
  assert.equal(placeForKey(k("1", { metaKey: true, target: inner }), true), null);
  const off = document.createElement("div"); off.setAttribute("contenteditable", "false");
  assert.equal(placeForKey(k("1", { metaKey: true, target: off }), true), "/now");
  assert.equal(macKeys({ platform: "MacIntel" }), true);
  assert.equal(macKeys({ userAgentData: { platform: "Windows" } }), false);
  assert.equal(macKeys({ platform: "Linux x86_64" }), false);
});

test("rail app: the shell mounts the rail, the brand leaves the header, and the keys go through placeForKey", () => {
  const app = read("js/app.js");
  assert.match(app, /import \{ rail, placeForKey \} from "\.\/rail\.js"/);
  assert.doesNotMatch(app, /class: "brand"|wordmark|class: "avatar"|rail-foot/, "no brand, wordmark or avatar in the header, no machine footer");
  assert.doesNotMatch(app, /const PLACES = \[/, "the order lives in js/rail.js only");
  assert.match(app, /railEl\.el,\s*h\("div", \{ class: "stage" \}/, "the rail is left of the stage");
  assert.doesNotMatch(app, /class: "top"|needs-pill|search-pop/, "the top bar is gone: the command bar and the rail's Search replace it");
  assert.match(app, /createCmdBar\(\)/);
  assert.match(app, /const href = placeForKey\(e, MAC\);/);
  // The page being left is hidden on the desk: the new address is current before leave() runs.
  assert.match(app, /current = key;\n(?: *\/\/.*\n)* *if \(was && !again\) leave\(wasKey, was, from, to, backward\);/);
  assert.match(app, /if \(phone\(\) \|\| !installed\(\)\) return;\s*const href = placeForKey/, "no rail keys on the phone, or in a browser tab (they switch the browser's own tabs)");
  // The phone shell's own header and tab bar (v2).
  assert.match(app, /h\("nav", \{ class: "tabbar", "aria-label": "Pages" \}, phLabels, moreTab\)/);
  assert.match(read("sw.js"), /"\/js\/rail\.js"/, "kept at install");
  const icons = read("js/icons.js");
  assert.match(icons, /\n {2}planner: '/);
  assert.match(icons, /\n {2}devices: '/);
});

test("rail css: 72 wide, 60 by 50 places, 12/16 labels, the badge the only colour, 120 ms fills, none under reduced motion", () => {
  const css = read("css/deck.css");
  decl(css, ".rail", /width: 72px; flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 12px 0/);
  decl(css, ".rail", /border-right: 1px solid var\(--rule\); background: var\(--bg\)/);
  for (const r of rules(css, ".rail")) assert.doesNotMatch(r.body, /216px/, "no 216 column left");
  assert.doesNotMatch(noComments(css), /width: 216px; flex-shrink: 0; display: flex; flex-direction: column; padding: 16px 12px/);
  decl(css, ".rail-end", /margin-top: auto/);
  decl(css, ".rail-home", /width: 40px; height: 40px; flex-shrink: 0; margin-bottom: 10px/);
  decl(css, ".rail-home", /border-radius: 10px/);
  assert.match(noComments(css), /\.rail-home circle \{ fill: var\(--mark-dot\) !important; \}/);
  assert.match(noComments(css), /\.rail\[data-needs\] \.rail-home circle \{ fill: var\(--beacon-dot\) !important; \}/);
  decl(css, ".rail-place", /width: 60px; height: 50px/);
  decl(css, ".rail-place", /gap: 4px/);
  decl(css, ".rail-place", /border-radius: 10px; color: var\(--label\)/);
  decl(css, ".rail-place", /font-size: var\(--size-meta, 12px\); line-height: var\(--line-meta, 16px\); font-weight: 400/);
  decl(css, ".rail-place", /transition: background-color var\(--motion-tap, 120ms\) var\(--ease, [^)]+\)\), color var\(--motion-tap, 120ms\)/);
  assert.match(noComments(css), /\.rail-place:hover, \.rail-place:active, \.rail-place\[aria-current="page"\] \{ background: var\(--hover\); color: var\(--text\); \}/);
  assert.match(noComments(css), /\.rail-place\[aria-current="page"\] \.rail-label \{ font-weight: 600; \}/);
  assert.match(noComments(css), /\.rail-place \.sm-badge \{ position: absolute; top: 4px; right: 8px; \}/);
  assert.match(noComments(css), /\.rail-place:focus-visible, \.rail-home:focus-visible, \.rail-avatar:focus-visible \{ outline: 2px solid var\(--focus\); outline-offset: 2px; \}/);
  decl(css, ".rail-avatar", /width: 32px; height: 32px; flex-shrink: 0; margin-top: 8px; border-radius: 16px/);
  decl(css, ".rail-avatar", /background: var\(--hover\); color: var\(--text\)/);
  decl(css, ".rail-initial", /font-size: 13px; line-height: 16px; font-weight: 600/);
  assert.match(noComments(css), /@media \(prefers-reduced-motion: reduce\) \{ \.rail-home, \.rail-place \{ transition: none; \} \}/);
  // No bone, violet, wash or left bar on a place: the badge (marks.css) is the only colour.
  for (const sel of [".rail", ".rail-place", ".rail-label", ".rail-avatar", ".rail-set"]) {
    for (const r of rules(css, sel)) {
      if (/focus-visible|rail-home/.test(r.sel)) continue;
      assert.doesNotMatch(r.body, /--beacon|--focus|--primary|--signal|border-left|box-shadow/, `${r.sel}: ${r.body}`);
    }
  }
  // The phone shell hides the rail and the list column; the header is still the first rule there.
  assert.match(css, /@media \(max-width: 719px\), \(max-height: 500px\) and \(pointer: coarse\) \{\n {2}\.rail \{ display: none; \}\n {2}\.rail-lower \{ display: none; \}/);
  // The list column is its own width, not the old rail's.
  decl(css, ".rail-lower", /width: 240px; min-width: 0; flex-shrink: 0/);
  decl(css, ".rail-lower", /overflow-x: hidden; overflow-y: auto/);
  assert.doesNotMatch(read("chat/chat.css"), /\.rail-set\b/, "the rail's groups do not share a name with chat's");
});

test("rail: a label on hover and focus, a labelled rail from 1200 px, and below 720 px the phone layout (the rail is gone)", () => {
  const css = noComments(read("css/shell-v2.css"));
  assert.match(css, /\.rail-place:hover \.rail-label, \.rail-place:focus-visible \.rail-label \{ opacity: 1;/);
  assert.match(css, /@media \(min-width: 1200px\) \{\s*:root:not\(\[data-rail="icons"\]\) \.rail \{/);
  assert.match(css, /pointer: none\) \{\s*:root\[data-rail="labels"\] \.rail \{/);
  assert.match(read("js/app.js"), /dataset\.rail = readRailMode\(\)/);
  assert.match(read("views/settings.js"), /"aria-label": "Rail"/, "the setting is in Settings, Appearance");
  // The phone layout starts below 720, so a 390 screen gets the tab bar and no rail.
  const deck = noComments(read("css/deck.css"));
  assert.match(deck, /@media \(max-width: 719px\), \(max-height: 500px\) and \(pointer: coarse\) \{\s*\.rail \{ display: none; \}/);
});

test("rail mode: auto by default, icons or labels kept per device, junk reads as auto", async () => {
  const { readRailMode, setRailMode, MODES } = await import("../js/rail-mode.js");
  const mem = () => { const m = new Map(); return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); }, removeItem: (/** @type {string} */ k) => { m.delete(k); } }; };
  const s = mem();
  const doc = /** @type {any} */ ({ documentElement: { dataset: {} } });
  assert.deepEqual([...MODES], ["auto", "icons", "labels"]);
  assert.equal(readRailMode(s), "auto");
  assert.equal(setRailMode("labels", { doc, store: s }), "labels");
  assert.equal(doc.documentElement.dataset.rail, "labels");
  assert.equal(readRailMode(s), "labels");
  setRailMode("auto", { doc, store: s });
  assert.equal(s.getItem("vyre.rail"), null, "auto is the absence of a choice");
  s.setItem("vyre.rail", "wide");
  assert.equal(readRailMode(s), "auto");
});
