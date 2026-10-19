// @ts-check
// A send appends the person's words or fails within its budget (group.js sendOnce): a step before the append that never answers (the kernel's append, the run adoption) fails the send as
// slow_step, naming the step, instead of holding it for ever. Each step is timed in the log at debug level, with no words. A retry with the same message id, once the server answers again, is said once.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups, SEND_BUDGET } from "./group.js";
import { createFakeKernel } from "./fake-reply-port.js";

const WORDS = "the private words of this message";

/** @param {any} t @param {{ hang?: "kernel-append" | "adopt-runs" }} o */
function rig(t, o) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  /** @type {string[]} */ const lines = [];
  const state = { hang: o.hang ?? null };
  const never = () => new Promise(() => {});
  const log = Object.assign((/** @type {string} */ m) => { lines.push(m); }, { debug: (/** @type {string} */ m) => { lines.push(`debug: ${m}`); } });
  const chats = { ...fk.kernel.chats, append: (/** @type {string} */ token, /** @type {any} */ m) => (state.hang === "kernel-append" ? never() : fk.kernel.chats.append(token, m)) };
  let n = 0;
  const ctx = {
    log,
    config: { stream: {} },
    kernel: { ...fk.kernel, chats },
    call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
      if (tool === "threads.of-chat") return state.hang === "adopt-runs" ? never() : { data: { runs: [] } };
      if (tool === "threads.start" || tool === "threads.send") return { data: { id: tool === "threads.start" ? `thr_${++n}` : String(i.thread) } };
      if (tool === "threads.get") return { data: { events: [] } };
      return { data: {} };
    },
  };
  const groups = createGroups({ ctx, logs, db, sendBudget: { totalMs: 400, stepMs: 250 } });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  const send = async (/** @type {string} */ grp, /** @type {string} */ who, /** @type {string} */ message) => {
    const meta = {};
    const c = /** @type {any} */ (fk.chats.get(grp));
    await groups.mirror(grp, { people: c.people, assistants: c.assistants }, meta, `person:${who}`, { person: who });
    return groups.send({ chat: grp, text: WORDS, message, to: ["assistant:kit"], cwd: "/tmp" }, meta);
  };
  const said = (/** @type {string} */ grp) => logs.get(grp).read(0).filter(f => f.type === "chat.user-message");
  return { fk, groups, send, said, lines, state };
}

test("the default budget lets a send append or fail in about 20 s, a step in less", () => {
  assert.ok(SEND_BUDGET.totalMs <= 20_000 && SEND_BUDGET.stepMs <= SEND_BUDGET.totalMs);
});

test("a kernel append that never answers fails the send as slow_step within its budget; nothing is stored, and the retry with the same id is said once", async t => {
  const r = rig(t, { hang: "kernel-append" });
  r.fk.create("c1", ["bob"], ["kit"]);
  const t0 = Date.now();
  await assert.rejects(r.send("c1", "bob", "msg-1"), (/** @type {any} */ e) => e.code === "slow_step" && e.detail && e.detail.step === "kernel-append" && /^slow_step: kernel-append/.test(e.message) && /Try again/.test(e.message));
  assert.ok(Date.now() - t0 < 2000, "it failed within its budget, not after a minute");
  assert.deepEqual(r.said("c1"), [], "the chat holds no message the kernel never took");
  const timed = r.lines.filter(l => l.startsWith("debug: stream: send msg-1"));
  assert.ok(timed.some(l => /kernel-append failed after \d+ ms/.test(l)), "the step that stalled is in the log");
  assert.ok(timed.some(l => /adopt-runs took \d+ ms/.test(l)) && timed.some(l => /person-session took \d+ ms/.test(l)), "so is each step before it");
  assert.ok(!r.lines.some(l => l.includes("private words")), "no line holds the message's words");
  // the server answers again: the person's Retry (the same message id) is said once
  r.state.hang = null;
  const ok = await r.send("c1", "bob", "msg-1");
  assert.equal(ok.message, "msg-1");
  const again = await r.send("c1", "bob", "msg-1");
  assert.equal(again.duplicate, true, "a second arrival of the same id is not said twice");
  assert.equal(r.said("c1").length, 1);
  assert.ok(r.lines.some(l => /^debug: stream: send msg-1 in c1: appended after \d+ ms$/.test(l)));
  await r.groups.idle();
});

test("a step that hangs earlier (adopting the chat's runs) fails the send the same way, naming that step", async t => {
  const r = rig(t, { hang: "adopt-runs" });
  r.fk.create("c2", ["bob"], ["kit"]);
  const t0 = Date.now();
  await assert.rejects(r.send("c2", "bob", "msg-2"), (/** @type {any} */ e) => e.code === "slow_step" && e.detail.step === "adopt-runs");
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(r.said("c2"), []);
  assert.ok(r.lines.some(l => /send msg-2 in c2: adopt-runs failed after \d+ ms/.test(l)));
});
