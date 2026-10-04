// @ts-check
// Send on chat's core: the row paints under u:<uuid> at once and the box's confirm never moves,
// re-keys or doubles it (native bar 9); a refusal takes it back.
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, confirmSend, createSession, dropLocal } from "../../../../deck/chat/core/session-state.js";
import { drawSend } from "./send.js";

const view = (/** @type {any} */ s) => s.items.map((/** @type {any} */ i) => `${i.kind}:${i.key}`);

function session() {
  const s = createSession("t1");
  applyEvent(s, { id: 1, type: "thread.started", payload: { thread: "t1", model: "opus" } });
  applyEvent(s, { id: 2, type: "thread.sent", payload: { thread: "t1", text: "Draft the Harlow Legal intake", uuid: "b0" } });
  applyEvent(s, { id: 3, type: "thread.text", payload: { thread: "t1", message: "m1", block: 0, text: "Done.", done: true } });
  applyEvent(s, { id: 4, type: "thread.finished", payload: { thread: "t1", ok: true } });
  return s;
}

test("send: the row paints at once under the composer's uuid", () => {
  const s = session();
  const keys = drawSend(s, { uuid: "mine", text: "Now the Northwind Bakery one", mode: null, at: 10, surface: "web" });
  assert.ok(keys.includes("u:mine"));
  assert.equal(s.items[s.items.length - 1].key, "u:mine");
});

test("send: the box's echo under its own uuid adopts the row: same key, same place, one row", () => {
  const s = session();
  drawSend(s, { uuid: "mine", text: "Now the Northwind Bakery one", mode: null, at: 10, surface: "web" });
  const before = view(s);
  applyEvent(s, { id: 5, type: "thread.sent", payload: { thread: "t1", text: "Now the Northwind Bakery one", uuid: "box-9", surface: "web" } });
  assert.deepEqual(view(s), before);
  applyEvent(s, { id: 6, type: "thread.text", payload: { thread: "t1", message: "m2", block: 0, delta: "On it" } });
  assert.deepEqual(view(s), [...before, "text:m:m2:0"]);
});

test("send: the answer's uuid first, then the echo: still one row under the first key", () => {
  const s = session();
  drawSend(s, { uuid: "mine", text: "Now the Northwind Bakery one", mode: null, at: 10, surface: "web" });
  const before = view(s);
  confirmSend(s, "mine", "box-9");
  applyEvent(s, { id: 5, type: "thread.sent", payload: { thread: "t1", text: "Now the Northwind Bakery one", uuid: "box-9", surface: "web" } });
  assert.deepEqual(view(s), before);
});

test("send: the echo under the composer's own uuid is the same row", () => {
  const s = session();
  drawSend(s, { uuid: "mine", text: "Now the Northwind Bakery one", mode: null, at: 10, surface: "web" });
  const before = view(s);
  applyEvent(s, { id: 5, type: "thread.sent", payload: { thread: "t1", text: "Now the Northwind Bakery one", uuid: "mine", surface: "web" } });
  assert.deepEqual(view(s), before);
});

test("send: a refusal takes the row back", () => {
  const s = session();
  const before = view(s);
  drawSend(s, { uuid: "mine", text: "Now the Northwind Bakery one", mode: null, at: 10, surface: "web" });
  assert.ok(dropLocal(s, "mine").includes("u:mine"));
  assert.deepEqual(view(s), before);
});

test("send: a steer draws the words and its marker (the core's localSend)", () => {
  const s = session();
  applyEvent(s, { id: 5, type: "thread.state", payload: { thread: "t1", state: "running" } });
  drawSend(s, { uuid: "st", text: "use the v2 template", mode: "steer", at: 10, surface: "web" });
  assert.deepEqual(view(s).slice(-2), ["steer:steer:st", "user:u:st"]);
});
