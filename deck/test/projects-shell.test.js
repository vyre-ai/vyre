// @ts-check
// Projects is a shell (#47, #42): a project's page lists its chats and each opens in Chat, scoped to the project; the page never draws a
// conversation or a start box of its own (the old copy did, with the wrong event fields). Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
const went = /** @type {string[]} */ ([]);
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} },
});
Object.defineProperty(globalThis, "history", { value: { state: null, pushState: (/** @type {any} */ _s, /** @type {any} */ _t, /** @type {string} */ url) => went.push(url), replaceState() {} }, configurable: true, writable: true });
globalThis.fetch = /** @type {any} */ (async (url) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  const data = tool === "projects.list" ? { projects: [{ slug: "harlow", name: "Harlow Legal", threads: 2, people: [] }] }
    : tool === "projects.threads" ? [{ id: "t-old", label: "Intake form", last: 1000, turns: 4 }]
    : tool === "threads.list" ? [{ id: "t-live", name: "Fix the footer", project: "harlow", state: "running", agent: "kit", last: 2000 }]
    : tool === "projects.context" ? { text: "Repo: harlow/site" } : [];
  return { status: 200, statusText: "", json: async () => ({ data }) };
});
const wait = (ms = 30) => new Promise(r => setTimeout(r, ms));
const { default: projects } = await import("../views/projects.js");
const ctxFor = (/** @type {any} */ params) => ({ root: new /** @type {any} */ (globalThis).Element("div"), params, query: new URLSearchParams(), on() {}, cleanup() {}, alive: () => true, shown: () => true, onShow() {}, rail() {} });

test("a project's page lists its chats, each a link into Chat scoped to the project, with a New chat that starts in Chat", async () => {
  const ctx = ctxFor({ slug: "harlow" });
  await projects(ctx); await wait();
  const hrefs = $$(ctx.root, "a").map(a => a.getAttribute("href"));
  assert.ok(hrefs.includes("/chat/harlow/t-live") && hrefs.includes("/chat/harlow/t-old"), hrefs.join(" "));
  assert.ok(hrefs.includes("/chat?new&project=harlow"), "New chat starts in Chat");
  assert.match(text(ctx.root), /Fix the footer/);
  assert.equal($(ctx.root, ".th-body"), null, "no conversation drawn here");
  assert.equal($(ctx.root, ".th-box"), null, "and no start box or composer of its own");
});

test("the old thread address on a project goes to Chat", async () => {
  went.length = 0;
  await projects(ctxFor({ slug: "harlow", thread: "t-live" }));
  assert.deepEqual(went, ["/chat/harlow/t-live"]);
});

test("the view no longer carries a conversation of its own", () => {
  const src = readFileSync(new URL("../views/projects.js", import.meta.url), "utf8");
  for (const gone of ["threadPane", "drawComposer", "th-stream", "Another surface", "mountSession"]) assert.ok(!src.includes(gone), `${gone} is gone`);
});
