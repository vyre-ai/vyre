// @ts-check
// door.stream events as frames: text, tool_call, cut and done, with the asker's chain as author and
// acts_for, and the provisional tail the door's hold-back leaves until text-done.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDoorAdapter, pipeDoor, drainDoor, validate, settle, HOLDBACK } from "./index.js";
import { SessionLog } from "./log.js";

const CHAIN = ["person:chris", "assistant:kit"];
async function* gen(/** @type {any[]} */ events) { for (const e of events) yield e; }
/** The text a screen holds for a message, and how much of it is still provisional. */
const shown = (/** @type {any[]} */ frames, /** @type {string} */ message, done = false) => {
  const text = frames.filter(f => f.type === "chat.text-delta" && f.data.message === message).map(f => f.data.text).join("");
  return { text, ...settle(text, done) };
};

test("text, tool_call, done: frames with the chain's author and acts_for, all valid", async () => {
  const log = new SessionLog("g");
  const frames = await drainDoor(log, gen([
    { type: "text", text: "Checking the menu. " },
    { type: "tool_call", id: "t1", name: "Read", input: { file_path: "/work/menu.txt" } },
    { type: "text", text: "Rye is 4." },
    { type: "done", id: "r1", usage: { in: 1, out: 2 } },
  ]), { message: "m1", chain: CHAIN });
  assert.deepEqual(frames.map(f => f.type.slice(5)), ["text-delta", "text-done", "tool-started", "text-delta", "text-done"]);
  for (const f of frames) {
    assert.deepEqual(validate(f), { ok: true });
    assert.equal(f.author, "assistant:kit");
    assert.equal(f.acts_for, "person:chris");
    assert.equal(f.message, "m1");
  }
  assert.deepEqual(frames.map(f => f.cur), [1, 2, 3, 4, 5]);
  assert.deepEqual(frames.filter(f => f.type === "chat.text-delta").map(f => f.data.index), [0, 1], "text after a tool call is a new block");
  assert.equal(frames[2].data.tool, "Read");
  assert.equal(frames[2].data.kind, "read");
  assert.equal(frames[2].data.tool_id, "t1");
});

test("a bare author with no chain acts for nobody; a chain of one does not act for itself", () => {
  const a = createDoorAdapter({ message: "m", author: "assistant:juno" });
  assert.equal(a.event({ type: "text", text: "x" })[0].acts_for, undefined);
  const b = createDoorAdapter({ message: "m", chain: ["assistant:juno"] });
  assert.equal(b.event({ type: "text", text: "x" })[0].acts_for, undefined);
  assert.throws(() => createDoorAdapter({ message: "m" }), /author/);
});

test("the door's held-back tail is provisional until text-done", async () => {
  const log = new SessionLog("g");
  const ad = createDoorAdapter({ message: "m", chain: CHAIN });
  // The door releases text late: the last ~40 characters of what it has seen are still held.
  pipeDoor(log, ad, { type: "text", text: "The bakery opens at seven on weekdays and eight on weekends. " });
  let s = shown(log.read(0), "m");
  assert.equal(s.provisional.length, HOLDBACK);
  assert.equal(s.stable, s.text.slice(0, s.text.length - HOLDBACK));
  pipeDoor(log, ad, { type: "text", text: "Closed Mondays." });
  pipeDoor(log, ad, { type: "done", id: "r" });
  s = shown(log.read(0), "m", true);
  assert.equal(s.provisional, "");
  assert.match(s.stable, /Closed Mondays\.$/);
});

test("a cut ends the message: text-cut with a note and no value, nothing after it, no text-done", () => {
  const log = new SessionLog("g");
  const ad = createDoorAdapter({ message: "m", chain: CHAIN, turn: "t1" });
  pipeDoor(log, ad, { type: "text", text: "Your account number is " });
  const cut = pipeDoor(log, ad, { type: "cut", code: "sealed_shape", class: "bank_account" });
  assert.equal(cut.length, 1);
  assert.equal(cut[0].type, "chat.text-cut");
  assert.deepEqual(validate(cut[0]), { ok: true });
  assert.equal(cut[0].data.note, "stopped: a sealed value was about to be shown");
  assert.equal(cut[0].data.code, "sealed_shape");
  assert.equal(cut[0].author, "assistant:kit");
  assert.equal(cut[0].acts_for, "person:chris");
  assert.equal(cut[0].turn, "t1");
  assert.deepEqual(pipeDoor(log, ad, { type: "text", text: "1234567" }), [], "nothing after a cut");
  assert.deepEqual(pipeDoor(log, ad, { type: "done", id: "r" }), []);
  assert.ok(!log.read(0).some(f => f.type === "chat.text-done"));
  assert.ok(!JSON.stringify(log.read(0)).includes("1234567"));
});

test("unknown events and empty text are ignored; two answers in one log keep their own authors", async () => {
  const log = new SessionLog("g");
  assert.deepEqual(createDoorAdapter({ message: "m", chain: CHAIN }).event({ type: "model.meta" }), []);
  assert.deepEqual(createDoorAdapter({ message: "m", chain: CHAIN }).event({ type: "text", text: "" }), []);
  await Promise.all([
    drainDoor(log, gen([{ type: "text", text: "one" }, { type: "done", id: "a" }]), { message: "m1", chain: ["person:alex", "assistant:kit"] }),
    drainDoor(log, gen([{ type: "text", text: "two" }, { type: "done", id: "b" }]), { message: "m2", chain: ["person:alex", "assistant:juno"] }),
  ]);
  const by = new Map(log.read(0).filter(f => f.type === "chat.text-delta").map(f => [f.message, f.author]));
  assert.deepEqual([...by], [["m1", "assistant:kit"], ["m2", "assistant:juno"]]);
});
