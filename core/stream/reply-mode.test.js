// @ts-check
// Reply mode (0.3.3 G04): each shared chat says when the AI answers. "every": the default assistant answers every person's message. "mention": only an @mention, or a reply to an assistant's message answers.
// Unset keeps the older rule (the default assistant answers unless the chat is two people talking). Anyone in the chat changes it; the change is a logged frame, so every participant sees it as a line.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups } from "./group.js";
import { createFakeKernel } from "./fake-reply-port.js";
import { whoAnswers } from "./routing.js";

const parts = [{ id: "person:bob" }, { id: "person:carol" }, { id: "assistant:kit" }];
const base = { participants: parts, defaultAssistant: "assistant:kit", author: "person:bob" };

test("routing: unset keeps the old rule; every answers even between people; mention answers only a mention or a reply to an assistant", () => {
  assert.deepEqual(whoAnswers({ ...base, text: "hi", previous: "person:carol" }), [], "unset: two people talking, no answer");
  assert.deepEqual(whoAnswers({ ...base, text: "hi", previous: "person:carol", mode: "every" }), ["assistant:kit"], "every: answers anyway");
  assert.deepEqual(whoAnswers({ ...base, text: "hi @carol", previous: "person:carol", mode: "every" }), ["assistant:kit"], "every: even a message that names a person");
  assert.deepEqual(whoAnswers({ ...base, text: "hi", previous: "person:bob", mode: "mention" }), [], "mention: a plain message gets nothing, even alone with the AI");
  assert.deepEqual(whoAnswers({ ...base, text: "@kit hi", mode: "mention" }), ["assistant:kit"], "mention: an @mention answers");
  assert.deepEqual(whoAnswers({ ...base, text: "and?", mode: "mention", repliedTo: "assistant:kit" }), ["assistant:kit"], "mention: a reply to an assistant's message answers that assistant");
  assert.deepEqual(whoAnswers({ ...base, text: "and?", mode: "mention", repliedTo: "person:carol" }), [], "mention: a reply to a person does not");
});

function rig(t) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  let n = 0;
  const ctx = { log: () => {}, kernel: fk.kernel, call: async (/** @type {string} */ tool) => (tool === "threads.start" ? { data: { id: `thr_${++n}` } } : tool === "threads.get" ? { data: { events: [] } } : { data: {} }) };
  const groups = createGroups({ ctx, logs, db, now: () => Date.now(), replyPort: fk.port });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  const call = async (/** @type {string} */ grp, /** @type {string} */ who) => { const meta = {}; const c = /** @type {any} */ (fk.chats.get(grp)); await groups.mirror(grp, { people: c.people, assistants: c.assistants }, meta, `person:${who}`, { person: who }); return meta; };
  return { fk, logs, groups, call };
}

test("a chat's reply mode: anyone in it sets it, it is a logged frame everyone has, and it decides who answers", async t => {
  const r = rig(t);
  r.fk.create("c1", ["bob", "carol"], ["kit"]);
  let m = await r.call("c1", "bob");
  const first = await r.groups.send({ chat: "c1", text: "hello", message: "m1", default: "assistant:kit", cwd: "/tmp" }, m);
  assert.deepEqual(first.routed, [], "unset, two people in the chat: the older rule, nobody answers a plain message");
  await r.groups.idle();
  // carol sets the mode to "mention": a plain message no longer wakes the AI
  m = await r.call("c1", "carol");
  const set = await r.groups.replyMode({ chat: "c1", mode: "mention" }, m);
  assert.equal(set.mode, "mention");
  const frame = r.logs.get("c1").read(0).find((/** @type {any} */ f) => f.type === "chat.reply-mode");
  assert.ok(frame && frame.data.mode === "mention" && frame.author === "person:carol", "the change is a frame with who made it");
  m = await r.call("c1", "bob");
  assert.deepEqual((await r.groups.send({ chat: "c1", text: "plain words", message: "m2", cwd: "/tmp" }, m)).routed, [], "mention mode: nobody answers a plain message");
  assert.deepEqual((await r.groups.send({ chat: "c1", text: "@kit what do you think?", message: "m3", cwd: "/tmp" }, m)).routed, ["assistant:kit"], "a mention does");
  // back to every
  await r.groups.replyMode({ chat: "c1", mode: "every" }, m);
  assert.deepEqual((await r.groups.send({ chat: "c1", text: "plain again", message: "m4", cwd: "/tmp" }, m)).routed, ["assistant:kit"], "every mode: it answers");
  assert.equal((await r.groups.replyMode({ chat: "c1", mode: "every" }, m)).unchanged, true, "the same mode again writes nothing");
  await assert.rejects(async () => r.groups.replyMode({ chat: "c1", mode: "sometimes" }, m), /every or mention/);
  // a person outside the chat cannot change it
  r.fk.create("c2", ["dave"], ["kit"]);
  const outsider = await r.call("c2", "dave");
  await assert.rejects(async () => r.groups.replyMode({ chat: "c1", mode: "mention" }, outsider));
});

test("a chat made with people and no AI starts on mention, as a default frame; a chat with an AI, or of one person, starts unset", async t => {
  const r = rig(t);
  const modes = (/** @type {string} */ grp) => r.logs.get(grp).read(0).filter((/** @type {any} */ f) => f.type === "chat.reply-mode");
  r.fk.create("p1", ["bob", "carol"], []);
  await r.call("p1", "bob");
  await r.call("p1", "carol");
  assert.equal(modes("p1").length, 1, "one default frame, not one per call");
  assert.equal(modes("p1")[0].data.mode, "mention");
  assert.equal(modes("p1")[0].data.default, true, "marked as a default so the chat shows no line for it");
  r.fk.create("p2", ["bob", "carol"], ["kit"]);
  await r.call("p2", "bob");
  assert.equal(modes("p2").length, 0, "an AI-centred chat is unset");
  r.fk.create("p3", ["bob"], []);
  await r.call("p3", "bob");
  assert.equal(modes("p3").length, 0, "a chat of one person is unset");
});
