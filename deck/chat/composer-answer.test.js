// @ts-check
// Who answers (model-picker.md): the chip names the provider, shows a chevron and a menu only with more than one account, and
// choosing one asks the box to switch the thread (threads.switch), never starting a new session. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, $$, text } from "../test/fake-dom.js";
import { createSession } from "./core/session-state.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
let rows = [
  { id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }], models: [{ id: "opus", label: "Opus" }] },
  { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true, plan: "ChatGPT Plus" }], models: [] },
];
let switchAnswer = { status: 200, body: { data: { ok: true } } };
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  if (tool === "providers.list") return { status: 200, statusText: "", json: async () => ({ data: rows }) };
  if (tool === "threads.switch") return { status: switchAnswer.status, statusText: "", json: async () => switchAnswer.body };
  return { status: 200, statusText: "", json: async () => ({ data: {} }) };
});
const { mountComposer } = await import("./composer.js");
const thread = () => "answer-test-" + Math.random().toString(36).slice(2);
const settle = () => new Promise(r => setTimeout(r, 60));
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
function mount(provider) {
  const th = thread();
  const s = createSession(th);
  s.provider = provider;
  return mountComposer({ thread: th, session: s, agents: [], threads: [], holder: null, surface: "chat" });
}

test("with two accounts the chip is a menu: it lists them, and choosing another asks threads.switch for that provider and account", async () => {
  calls.length = 0;
  const c = mount("claude");
  await settle();
  const chip = $(c.el, ".composer-answer");
  assert.ok(chip, "the chip is there");
  assert.match(chip.getAttribute("aria-label"), /Answered by Claude/);
  assert.ok($(chip, ".pmark"), "wearing the provider's badge");
  click(chip); await settle();
  const items = $$(c.el, "[role=option]");
  assert.deepEqual(items.map(i => text(i).replace(/\s+/g, " ")).map(t => /Personal/.test(t) ? "Personal" : /OpenAI/.test(t) ? "OpenAI" : t), ["Personal", "OpenAI"]);
  assert.match(text(items[1]), /ChatGPT Plus/);
  click(items[1]); await settle();
  assert.deepEqual(calls.find(x => x.tool === "threads.switch")?.input.provider, "codex");
  assert.equal(calls.find(x => x.tool === "threads.switch")?.input.account, "x1");
  c.stop();
});

test("with one account the chip names who answers and does nothing; choosing the account already answering sends nothing", async () => {
  calls.length = 0;
  rows = [rows[0]];
  const c = mount("claude");
  await settle();
  const chip = $(c.el, ".composer-answer");
  assert.ok(chip.disabled === true || chip.getAttribute("disabled") !== null, "nothing to choose");
  assert.equal($$(chip, "svg").length, 1, "the mark only, no chevron");
  click(chip); await settle();
  assert.equal($$(c.el, "[role=option]").length, 0);
  assert.equal(calls.filter(x => x.tool === "threads.switch").length, 0);
  c.stop();
});

test("a switch refused while a turn runs says so in words and changes nothing", async () => {
  calls.length = 0;
  rows = [
    { id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }], models: [] },
    { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true }], models: [] }];
  switchAnswer = { status: 409, body: { error: { code: "busy", message: "a turn is running" } } };
  const c = mount("claude");
  await settle();
  click($(c.el, ".composer-answer")); await settle();
  click($$(c.el, "[role=option]")[1]); await settle();
  assert.match(text(c.el), /A turn is running\. Stop it or wait for it to end, then choose again\./);
  c.stop();
});
