#!/usr/bin/env node
// scripts/chat-walk.mjs: the short timed walk of Vyre's chat path (SPEC-0.3.0 12.11, cut to what the server can time on its own). It prints one line per measure:
//   first word    from a person's send to the first word of the answer reaching a watching screen, through the real group path with the kernel stand-in (the server's own share of the wait;
//                 the model's time to think is not in it)
//   resume        a screen that was away opens a 2,000-line chat and receives every frame it missed
//   cold resume   the same from the stored log with nothing in memory (a restart, or a phone back after a day)
//   smoothness    the slowest single frame, and the 99th percentile, while 2,000 lines stream in at once to a watching screen
// Numbers are milliseconds on this machine. The native apps' side (keystrokes, screen smoothness) is measured by hand.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as config from "../core/config/index.js";
import { open } from "../core/store/index.js";
import { Logs } from "../core/stream/log.js";
import { createGroups } from "../core/stream/group.js";
import { serve } from "../core/stream/server.js";
import { createFakeKernel } from "../core/stream/fake-reply-port.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "chat-walk-"));
const p = config.ensure(home);
const db = open(p.db);
const fk = createFakeKernel();
const logs = new Logs({ maxFrames: 100000, coalesce: false });
let n = 0;
const ctx = { log: () => {}, kernel: fk.kernel, call: async (/** @type {string} */ tool) => (tool === "threads.start" ? { data: { id: `thr_${++n}` } } : tool === "threads.get" ? { data: { events: [] } } : { data: {} }) };
const groups = createGroups({ ctx, logs, db, now: () => Date.now(), replyPort: fk.port });
let eid = 0;
const ms = (/** @type {number} */ t) => Math.round((performance.now() - t) * 10) / 10;
const lines = [];
const say = (/** @type {string} */ k, /** @type {string} */ v) => { lines.push(`${k.padEnd(14)} ${v}`); console.log(`${k.padEnd(14)} ${v}`); };

fk.create("walk", ["bob"], ["kit"]);
const meta = {};
await groups.mirror("walk", { people: ["bob"], assistants: ["kit"] }, meta, "person:bob", { person: "bob" });
const frames = /** @type {any[]} */ ([]);
const viewer = { id: "person:bob", roles: /** @type {string[]} */ ([]), ...groups.viewerFor("walk", "person:bob") };
const watching = serve(logs.get("walk"), { send: f => frames.push({ f, at: performance.now() }), onClose: () => {} }, { from: 0, viewer });

// first word
const t0 = performance.now();
await groups.send({ chat: "walk", text: "what is the fee?", message: "w1", to: ["assistant:kit"], cwd: os.tmpdir() }, meta);
const thread = String(/** @type {any} */ (groups.member("walk", "assistant:kit")).thread);
groups.onEvent({ id: ++eid, type: "thread.text", thread, payload: { message: "a1", delta: "The fee is " } });
await groups.idle();
const first = frames.find(x => x.f.type === "chat.text-delta");
say("first word", first ? `${Math.round((first.at - t0) * 10) / 10} ms from send to the word on the screen` : "no word arrived");
groups.onEvent({ id: ++eid, type: "thread.text", thread, payload: { message: "a1", done: true } });

// 2,000 lines streaming in
const body = "A line of an answer about the estate plan, long enough to be a real line of text. ".repeat(2);
const gaps = [];
let last = performance.now();
const before = frames.length;
for (let i = 0; i < 2000; i++) {
  const t = performance.now();
  groups.onEvent({ id: ++eid, type: "thread.text", thread, payload: { message: `l${i}`, delta: body } });
  groups.onEvent({ id: ++eid, type: "thread.text", thread, payload: { message: `l${i}`, done: true } });
  gaps.push(performance.now() - t); last = performance.now();
}
void last;
await groups.idle();
gaps.sort((a, b) => a - b);
say("smoothness", `2,000 lines in: slowest ${Math.round(gaps[gaps.length - 1] * 10) / 10} ms, 99th percentile ${Math.round(gaps[Math.floor(gaps.length * 0.99)] * 100) / 100} ms, median ${Math.round(gaps[Math.floor(gaps.length / 2)] * 100) / 100} ms; the screen received ${frames.length - before} frames`);
watching.close();

// resume: a screen that was away
const head = logs.get("walk").head;
const t1 = performance.now();
const got = /** @type {any[]} */ ([]);
const s2 = serve(logs.get("walk"), { send: f => got.push(f), onClose: () => {} }, { from: 0, viewer: { id: "person:bob", roles: [], ...groups.viewerFor("walk", "person:bob") } });
say("resume", `${ms(t1)} ms to replay ${got.filter(f => f.cur > 0).length} frames of a log of ${head}`);
s2.close();

// cold resume: nothing in memory
groups.stop(); logs.close();
const logs2 = new Logs({ maxFrames: 100000, coalesce: false, db });
const t2 = performance.now();
const cold = /** @type {any[]} */ ([]);
const s3 = serve(logs2.get("walk"), { send: f => cold.push(f), onClose: () => {} }, { from: 0 });
say("cold resume", `${ms(t2)} ms from the stored log, ${cold.filter(f => f.cur > 0).length} frames`);
s3.close(); logs2.close(); db.close();
fs.rmSync(home, { recursive: true, force: true });
fs.writeFileSync(path.join(os.tmpdir(), "chat-walk.txt"), lines.join("\n") + "\n");
