// @ts-check
// /quick: the hotkey panel's compact ask (C22). Sample world only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
function vyred(answers) {
  globalThis.fetch = /** @type {any} */ (async (url) => {
    const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
    const a = tool in answers ? answers[tool] : { $error: { code: "no_such_tool", message: "no such tool" } };
    return a && a.$error ? { status: 409, statusText: "", json: async () => ({ error: a.$error }) } : { status: 200, statusText: "", json: async () => ({ data: a }) };
  });
}
const T = "0f3c9a1e-5b7d-4c2a-9e10-aa11bb22cc33";
const mk = () => ({ root: doc.createElement("div"), alive: () => true, cleanup: () => {}, params: {}, query: new URLSearchParams() });

test("/quick with the assistant: Open in full goes to its thread, and the chat session is mounted under it", async () => {
  vyred({ "assistant.daily": { thread: T } });
  const { default: quick } = await import("../views/quick.js");
  const ctx = mk();
  const mounted = [];
  await quick(ctx, { mount: (el, o) => { mounted.push(o.thread); return () => {}; } });
  assert.deepEqual(mounted, [T]);
  assert.equal($(ctx.root, ".quick-full").getAttribute("href"), `/chat/thread/${T}`);
  assert.ok($(ctx.root, ".quick-body"));
});

test("/quick with no assistant says so in one line", async () => {
  vyred({});
  const { default: quick } = await import("../views/quick.js");
  const ctx = mk();
  await quick(ctx);
  assert.match(text(ctx.root), /Ask needs the assistant/);
});
