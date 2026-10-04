// @ts-check
// Who answers (model-picker.md): the chip names the provider, shows a chevron and a menu only with more than one account, and
// choosing one asks the box to switch the thread (threads.switch), never starting a new session. Sample world only.

import "../../scripts/mac-test-guard.mjs";
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
  assert.deepEqual(items.map(i => text(i).replace(/\s+/g, " ")).map(t => /^Personal/.test(t) ? "Personal" : /^OpenAI/.test(t) ? "OpenAI" : t.replace(/now$/, "")), ["Personal", "Opus", "OpenAI", "Effort: Default", "Effort: Low", "Effort: Medium", "Effort: High", "Effort: Extra high", "Effort: Max"]);
  assert.match(text(items[2]), /ChatGPT Plus/);
  click(items[2]); await settle();
  assert.deepEqual(calls.find(x => x.tool === "threads.switch")?.input.provider, "codex");
  assert.equal(calls.find(x => x.tool === "threads.switch")?.input.account, "x1");
  c.stop();
});

test("with one account the chip names who answers and does nothing; choosing the account already answering sends nothing", async () => {
  calls.length = 0;
  rows = [{ id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true, default: true }], models: [], capabilities: { effort: false } }];
  const c = mount("codex");
  await settle();
  const chip = $(c.el, ".composer-answer");
  assert.ok(chip.disabled === true || chip.getAttribute("disabled") !== null, "nothing to choose");
  assert.equal($$(chip, "svg").length, $$($(chip, ".pmark"), "svg").length, "the mark only, no chevron");
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

function type(c, value) {
  c.input.value = value; c.input.setSelectionRange(value.length, value.length);
  c.input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("input"), { inputType: "insertText" }));
}
const enter = c => c.input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: c.input }));

test("@codex at the start sends threads.send with an account mention (one turn, the session stays), never as a teammate; an unknown @word is still a teammate", async () => {
  rows = [
    { id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }], models: [] },
    { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true }], models: [] }];
  calls.length = 0;
  const c = mount("claude");
  await settle();
  type(c, "@codex make an image of a red door");
  enter(c); await settle();
  const sent = calls.find(x => x.tool === "threads.send");
  assert.ok(sent, "sent through threads.send");
  assert.deepEqual(sent.input.mentions, [{ kind: "account", id: "codex", name: "Codex" }]);
  assert.match(sent.input.text, /^@codex make an image/);
  assert.equal(calls.filter(x => x.tool === "team.ask").length, 0);
  assert.equal(calls.filter(x => x.tool === "threads.switch").length, 0, "the session is not switched");
  calls.length = 0;
  type(c, "@zzz hello");
  enter(c); await settle();
  assert.equal(calls.filter(x => x.tool === "threads.send").length, 0, "not an account, so not sent as a message");
  c.stop();
});

test("the @ menu offers the accounts only at the very start of the draft, and picking one writes its word", async () => {
  calls.length = 0;
  const c = mount("claude");
  await settle();
  type(c, "@co");
  await new Promise(r => setTimeout(r, 300));
  const items = $$(c.el, "[role=option]");
  assert.ok(items.some(i => /Codex/.test(text(i)) && /Accounts/.test(text(i))), "Codex is offered as an account");
  click(items.find(i => /Accounts/.test(text(i))));
  assert.equal(c.value().trim(), "@Codex");
  c.stop();
});

test("each account lists its models: a model of the answering account asks threads.model; a model of another asks threads.switch with it", async () => {
  rows = [
    { id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }], models: [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }] },
    { id: "codex", label: "Codex", accounts: [{ id: "x1", label: "OpenAI", signed_in: true }], models: [{ id: "gpt-5", label: "GPT-5" }] }];
  switchAnswer = { status: 200, body: { data: { ok: true } } };
  calls.length = 0;
  const c = mount("claude");
  await settle();
  click($(c.el, ".composer-answer")); await settle();
  let items = $$(c.el, "[role=option]");
  assert.deepEqual(["Personal", "Opus", "Sonnet", "OpenAI", "GPT-5"].map((w, i) => text(items[i]).startsWith(w)), [true, true, true, true, true]);
  click(items[2]); await settle();
  assert.deepEqual(calls.find(x => x.tool === "threads.model")?.input.model, "sonnet");
  assert.equal(calls.filter(x => x.tool === "threads.switch").length, 0);
  calls.length = 0;
  click($(c.el, ".composer-answer")); await settle();
  items = $$(c.el, "[role=option]");
  click(items[4]); await settle();
  const sw = calls.find(x => x.tool === "threads.switch")?.input;
  assert.deepEqual([sw.provider, sw.account, sw.model], ["codex", "x1", "gpt-5"]);
  c.stop();
});

test("one chip says it all: who, model and effort; choosing an effort asks threads.effort, Default asks for none", async () => {
  rows = [{ id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }], models: [{ id: "opus", label: "Opus" }] }];
  calls.length = 0;
  const th = thread();
  const s = createSession(th); s.provider = "claude"; s.model = "claude-opus-4-5"; /** @type {any} */ (s).effort = "high";
  const c = mountComposer({ thread: th, session: s, agents: [], threads: [], holder: null, surface: "chat" });
  await settle();
  assert.match(text($(c.el, ".composer-answer")), /Claude · Opus high/);
  assert.equal($(c.el, ".composer-model"), null, "no separate model chip");
  click($(c.el, ".composer-answer")); await settle();
  const low = $$(c.el, "[role=option]").find(i => /Effort: Low/.test(text(i)));
  click(low); await settle();
  assert.deepEqual(calls.find(x => x.tool === "threads.effort")?.input, { thread: th, effort: "low" });
  click($(c.el, ".composer-answer")); await settle();
  click($$(c.el, "[role=option]").find(i => /Effort: Default/.test(text(i)))); await settle();
  assert.deepEqual(calls.filter(x => x.tool === "threads.effort").at(-1)?.input, { thread: th });
  c.stop();
});

test("typing @claude with two Claude accounts shows which account this turn runs on", async () => {
  rows = [{ id: "claude", label: "Claude", accounts: [{ id: "c1", label: "Personal", signed_in: true, default: true }, { id: "c2", label: "Work", signed_in: true }], models: [] }];
  const c = mount("claude");
  await settle();
  type(c, "@claude summarise this");
  assert.match(text($(c.el, ".composer-runs-on")), /This turn runs on Claude \(Personal\)/);
  type(c, "@Claude-Work summarise this");
  assert.match(text($(c.el, ".composer-runs-on")), /Claude \(Work\)/);
  type(c, "summarise this");
  assert.equal($(c.el, ".composer-runs-on"), null);
  c.stop();
});
