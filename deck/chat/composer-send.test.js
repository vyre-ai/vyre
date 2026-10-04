// @ts-check
// Send gives feedback and never sends twice (#39): five fast presses are one message, the same words typed again while the first is
// still being answered are held, and the row says "Sending…" until the box answers. Sample world only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, $, text } from "../test/fake-dom.js";
import { createSession, localSend, confirmSend } from "./core/session-state.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, {
  DOMParser: class { parseFromString() { const E = /** @type {any} */ (globalThis).Element; const svg = new E("svg"); svg.append(new E("circle")); return { documentElement: svg }; } },
  CustomEvent: class extends /** @type {any} */ (globalThis).Event { constructor(t, o) { super(t); this.detail = o?.detail; } },
  dispatchEvent: () => true,
});
const calls = /** @type {any[]} */ ([]);
let answerAfter = 60;
globalThis.fetch = /** @type {any} */ (async (url, o) => {
  const tool = decodeURIComponent(String(url).split("/v1/tools/")[1]);
  calls.push({ tool, input: JSON.parse(o.body) });
  if (tool === "threads.send") await new Promise(r => setTimeout(r, answerAfter));
  return { status: 200, statusText: "", json: async () => ({ data: tool === "threads.send" ? { sent: true, thread: "t" } : {} }) };
});
const { mountComposer } = await import("./composer.js");
const { userRow } = await import("./blocks.js");
const wait = ms => new Promise(r => setTimeout(r, ms));
const type = (c, v) => { c.input.value = v; c.input.setSelectionRange(v.length, v.length); c.input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("input"), { inputType: "insertText" })); };
const enter = c => c.input.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("keydown"), { key: "Enter", target: c.input }));
const mount = () => { const th = "send-" + Math.random().toString(36).slice(2); return mountComposer({ thread: th, session: createSession(th), agents: [], threads: [], holder: null, surface: "chat" }); };

test("five fast presses of Enter send one message, with one id", async () => {
  calls.length = 0;
  const c = mount();
  type(c, "hey");
  for (let i = 0; i < 5; i++) enter(c);
  await wait(150);
  const sends = calls.filter(x => x.tool === "threads.send");
  assert.equal(sends.length, 1, "one threads.send for five presses");
  assert.equal(sends[0].input.text, "hey");
  assert.ok(sends[0].input.uuid, "with a client message id the box can drop a repeat by");
  assert.equal(c.value(), "", "the composer cleared");
  c.stop();
});

test("the same words typed again while the first send is still being answered are held", async () => {
  calls.length = 0;
  const c = mount();
  type(c, "hey");
  enter(c);
  type(c, "hey");
  enter(c);
  await wait(150);
  assert.equal(calls.filter(x => x.tool === "threads.send").length, 1);
  c.stop();
});

test("the row says Sending until the box answers, then nothing; a send that failed leaves no row", () => {
  const s = createSession("t");
  localSend(s, { uuid: "u1", text: "hey", mode: "send", at: 1 });
  const user = /** @type {any} */ (s.items[0]);
  assert.equal(user.accepted, undefined);
  assert.match(text(userRow("you", "hey", 1, null, 0, true)), /Sending…/);
  assert.doesNotMatch(text(userRow("you", "hey", 1, null, 0, false)), /Sending/);
  confirmSend(s, "u1", undefined);
  assert.equal(user.accepted, true, "the box answered: no longer sending");
  confirmSend(s, "u1", "box-uuid");
  assert.equal(user.uuid, "box-uuid", "the box's id for the message is kept");
});
