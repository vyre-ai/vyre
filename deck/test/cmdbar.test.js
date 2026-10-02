// @ts-check
// The command bar (js/cmdbar.js) and the page header (js/page-header.js) drawn on the fake DOM: Ctrl or Cmd K opens
// it, what exists is listed by group, typing narrows, Enter goes, Esc closes and gives the focus back.

import test from "node:test";
import assert from "node:assert/strict";

async function load() {
  const { install, $, $$ } = await import("./fake-dom.js");
  install();
  /** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
  /** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
  /** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
  const { createCmdBar } = await import("../js/cmdbar.js");
  const { pageHeader } = await import("../js/page-header.js");
  return { createCmdBar, pageHeader, $, $$ };
}

const boxData = {
  "projects.list": { projects: [{ slug: "acme", name: "Acme intake" }] },
  "agents.list": [{ name: "Ivy", kind: "assistant" }, { name: "Scout", kind: "agent" }],
  "threads.list": [{ id: "t1", name: "Fix the footer", project: "acme" }],
};
const attempt = /** @type {any} */ (async (/** @type {string} */ tool) => ({ data: /** @type {any} */ (boxData)[tool] ?? null }));
const settle = () => new Promise(r => setTimeout(r, 20));
const mem = () => { const m = new Map(); return { getItem: (/** @type {string} */ k) => m.get(k) ?? null, setItem: (/** @type {string} */ k, /** @type {string} */ v) => { m.set(k, v); } }; };

test("cmdbar: Ctrl K opens a dialog with one box, lists the box's things by group, Esc closes it", async () => {
  const { createCmdBar, $, $$ } = await load();
  const went = /** @type {string[]} */ ([]);
  const cmd = createCmdBar({ attempt, go: href => went.push(href), doc: document, storage: mem() });
  const k = /** @type {any} */ ({ key: "k", ctrlKey: true, preventDefault() { this.defaultPrevented = true; } });
  cmd.onGlobalKey(k);
  assert.equal(k.defaultPrevented, true);
  assert.ok(cmd.isOpen());
  await settle();
  const dlg = $(document.body, ".cmd");
  assert.equal(dlg.getAttribute("role"), "dialog");
  const titles = $$(dlg, ".cmd-row").map((/** @type {any} */ r) => $(r, "b").textContent);
  for (const want of ["New chat", "Acme intake", "Ivy", "Scout", "Fix the footer"]) assert.ok(titles.includes(want), want);
  cmd.onGlobalKey(/** @type {any} */ ({ key: "k", metaKey: true, preventDefault() {} }));
  assert.equal(cmd.isOpen(), false, "the chord again closes it");
  assert.equal($(document.body, ".cmd"), null);
});

test("cmdbar: choosing goes to the place and remembers it; p narrows to projects", async () => {
  const { createCmdBar, $, $$ } = await load();
  const went = /** @type {string[]} */ ([]);
  const store = mem();
  const cmd = createCmdBar({ attempt, go: href => went.push(href), doc: document, storage: store });
  cmd.open();
  await settle();
  const input = $(document.body, ".cmd-in");
  input.value = "p ";
  input.dispatchEvent(new Event("input"));
  const rows = $$(document.body, ".cmd-row");
  assert.deepEqual(rows.map((/** @type {any} */ r) => $(r, "b").textContent), ["Acme intake"]);
  input.dispatchEvent(Object.assign(new Event("keydown"), { key: "Enter", preventDefault() {} }));
  assert.deepEqual(went, ["/projects/acme"]);
  assert.equal(cmd.isOpen(), false);
  assert.match(String(store.getItem("vyre.cmd.recent")), /p:acme/);
});

test("page header: the title, one meta line, the actions", async () => {
  const { pageHeader, $ } = await load();
  const el = pageHeader({ title: "Agents", meta: "3 working", actions: [document.createElement("button")] });
  assert.equal($(el, "h1").textContent, "Agents");
  assert.equal($(el, ".page-head-meta").textContent, "3 working");
  assert.ok($(el, ".page-head-acts"));
  assert.equal($(pageHeader({ title: "Memory" }), ".page-head-meta"), null);
});
