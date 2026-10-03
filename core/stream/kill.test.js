// @ts-check
// Kill-and-resume: a transport that drops the connection at a random byte mid-reply, a seeded 200
// times, direct and through a relay-like hop. The reassembled text must equal the emitted text:
// nothing lost, nothing repeated, cursors delivered strictly in order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionLog } from "./log.js";
import { connect } from "./client.js";
import { prng, Sched, makeLink } from "./testkit.js";

const WORDS = ["alpha ", "béta ", "漢字 ", "gamma\n", "😀 ", "delta, ", "x", "epsilon ", "zü "];

/** One iteration; returns a summary. @param {number} seed @param {{ relay: boolean, ring: number, coalesce?: boolean, lossy?: boolean }} o */
async function run(seed, o) {
  const rnd = prng(seed);
  const sched = new Sched();
  const log = new SessionLog("s1", { maxFrames: o.ring, coalesce: o.coalesce !== false, mergeChars: 200, now: () => sched.t });
  const stats = { opens: 0, kills: 0, silent: 0, bytes: 0 };
  let emitted = "";
  let text = "";
  let snapshots = 0, producerDone = false;
  /** @type {number[]} */ const seen = [];
  /** @type {string[]} */ const order = [];

  const client = connect({
    open: makeLink({ log, sched, rnd, relay: o.relay, stats, ...(o.lossy ? { dropRate: 0.06, dupRate: 0.06, faultRate: 0.3 } : {}) }),
    timers: sched,
    random: rnd,
    snapshot: () => { snapshots++; text = emitted; return { cur: log.head }; },
    onFrame: f => {
      seen.push(f.cur);
      if (f.type === "session.text-delta") text += f.data.text;
      else order.push(f.type);
    },
  });

  const n = 40 + Math.floor(rnd() * 120);
  let at = 1;
  for (let i = 0; i < n; i++) {
    at += Math.floor(rnd() * 30);
    sched.setTimeout(() => {
      const w = WORDS[Math.floor(rnd() * WORDS.length)];
      emitted += w;
      log.append("text-delta", { message: "m1", index: 0, text: w }, { turn: "1" });
      if (rnd() < 0.08) log.append("tool-started", { tool_id: `t${i}`, tool: "Bash", kind: "shell", summary: "ls" }, { turn: "1" });
      if (i === n - 1) { log.append("text-done", { message: "m1" }, { turn: "1" }); producerDone = true; }
    }, at);
  }

  await sched.run(() => producerDone && client.last === log.head);
  const summary = { last: client.last, head: log.head, text: text === emitted, snapshots, ...stats, frames: seen.length };
  client.close();
  log.close();
  assert.equal(producerDone, true, `seed ${seed}: producer finished`);
  assert.equal(client.last, log.head, `seed ${seed}: the client caught up (last ${client.last}, head ${log.head})`);
  assert.equal(text, emitted, `seed ${seed}: reassembled text equals emitted text`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `seed ${seed}: cursors delivered in order and once (${seen[i - 1]} then ${seen[i]})`);
  return { summary, snapshots };
}

for (const relay of [false, true]) {
  test(`kill-and-resume x200, ${relay ? "through a relay-like hop" : "direct"}: nothing lost or repeated`, async () => {
    let kills = 0, opens = 0, resets = 0;
    for (let i = 0; i < 200; i++) {
      // Every third iteration keeps a ring so small that a long outage falls off it (reset, snapshot, resume).
      const small = i % 3 === 0;
      const { summary, snapshots } = await run(1000 + i + (relay ? 5000 : 0), { relay, ring: small ? 6 : 4000, coalesce: i % 2 === 0 });
      kills += summary.kills; opens += summary.opens; resets += snapshots;
      if (!small) assert.equal(snapshots, 0, `seed ${i}: a big ring never needs a snapshot`);
    }
    assert.ok(kills > 100, `the faults really happened (${kills} kills over ${opens} connections)`);
    console.log(JSON.stringify({ test: "kill-and-resume", relay, iterations: 200, kills, opens, snapshots: resets }));
  });
}

test("a hop that loses or repeats messages while the link stays up: gaps are found, repeats dropped (x100)", async () => {
  for (let i = 0; i < 100; i++) await run(9000 + i, { relay: i % 2 === 0, ring: 4000, coalesce: i % 4 < 2, lossy: true });
});

test("kill-and-resume is deterministic for a seed", async () => {
  const a = await run(4242, { relay: true, ring: 4000 });
  const b = await run(4242, { relay: true, ring: 4000 });
  assert.deepEqual(a.summary, b.summary);
});
