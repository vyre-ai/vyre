// @ts-check
// No empty rows (the user's Deck drew six empty replies and a turn with no words): in its own mounted session view, an event with no words
// draws no row and no header for it, and an item kind the Deck has no drawing for draws a labelled line. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
const store = new Map();
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {},
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
});
Object.defineProperty(globalThis, "history", { value: { state: null, pushState() {}, replaceState() {} }, configurable: true, writable: true });
const E = /** @type {any} */ (globalThis).Element.prototype, El = /** @type {any} */ (globalThis).Element;
const sibs = n => (n.parentNode ? n.parentNode.childNodes : []);
Object.defineProperties(E, {
  previousElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) - 1; i >= 0; i--) if (s[i] instanceof El) return s[i]; return null; } },
  nextElementSibling: { get() { const s = sibs(this); for (let i = s.indexOf(this) + 1; i < s.length; i++) if (s[i] instanceof El) return s[i]; return null; } },
  nextSibling: { get() { const s = sibs(this); return s[s.indexOf(this) + 1] || null; } },
  lastElementChild: { get() { const c = this.children; return c[c.length - 1] || null; } },
});
E.insertBefore = function (n, ref) { if (!ref) { this.append(n); return n; } n.remove(); this.childNodes.splice(this.childNodes.indexOf(ref), 0, n); n.parentNode = this; return n; };
E.replaceWith = function (n) { const p = this.parentNode; if (!p) return; p.insertBefore(n, this); this.remove(); };
E.after = function (n) { this.parentNode.insertBefore(n, this.nextSibling); };

const T = "empty-test-thread";
const at = Date.now() - 5000;
const events = [
  { id: 1, type: "thread.started", at, payload: { provider: "claude", model: "sonnet" } },
  { id: 2, type: "thread.sent", at: at + 1, payload: { text: "hey", surface: "deck", uuid: "u1" } },
  { id: 3, type: "thread.text", at: at + 2, payload: { message: "m0", block: 0, text: "", done: true } },
  { id: 4, type: "thread.text", at: at + 3, payload: { message: "m1", block: 0, kind: "reasoning", text: "", done: true } },
  { id: 5, type: "thread.text", at: at + 4, payload: { message: "m2", block: 0, text: "   ", done: true } },
  { id: 6, type: "thread.text", at: at + 5, payload: { message: "m3", block: 0, text: "Hello there", done: true } },
  { id: 7, type: "thread.finished", at: at + 6, payload: { ok: true } },
];
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const ok = data => ({ status: 200, statusText: "", json: async () => ({ data }) });
  if (tool === "threads.get") return ok({ thread: { id: T, name: "t", cwd: "/w", status: "idle", canonical_status: "waiting", agent: null }, events, asks: [] });
  if (tool === "recall.transcript") return { status: 404, statusText: "", json: async () => ({ error: { code: "not_found", message: "not found" } }) };
  if (tool === "system.info") return ok({ owner: { name: "alex" } });
  return ok(tool === "memory.facts" ? { facts: [] } : tool === "threads.asks" ? [] : {});
});
const wait = (ms = 20) => new Promise(r => setTimeout(r, ms));
const { mountSession, unknownItemText } = await import("./session.js");
const container = new El("div");
doc.body.append(container);
const stop = mountSession(container, { thread: T, project: null, onBack() {} });
await wait(150);

test("a reply or a thought with no words draws no row, and the one real reply draws once", () => {
  assert.match(text(container), /Hello there/);
  const replies = $$(container, ".cv-text");
  assert.equal(replies.length, 1, "only the reply that has words");
  for (const r of [...replies, ...$$(container, ".cv-think")]) assert.ok(text(r).trim().length > 0, "no empty row: " + String(r.className));
});

test("no header for a reply that has nothing under it: one header for the one reply", () => {
  assert.equal($$(container, ".cv-head").length, 1);
});

test("an item kind the Deck has no drawing for says so in a line", () => {
  assert.equal(unknownItemText("hologram"), "This update (hologram) can't be shown here yet.");
  assert.match(unknownItemText(undefined), /\(unknown\)/);
  assert.ok(unknownItemText("x".repeat(200)).length < 100, "a long kind is cut");
  stop();
});
