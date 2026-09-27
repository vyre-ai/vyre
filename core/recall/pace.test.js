// @ts-check
// Recall's background work is light: paced, paused when the machine cannot spare it, and the
// model in a niced process of its own on one thread. The last test measures it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pacer, gate, parsePmset } from "./pace.js";
import { install, spawnEmbedder } from "./embed.js";
import { Indexer } from "./indexer.js";
import { MIGRATIONS } from "./schema.js";
import { open, migrate } from "../store/index.js";
import { fakeNpm } from "./testing.js";
import { writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

test("pace: after work, sleep so the work is at most `duty` of the clock, capped", async () => {
  const slept = [];
  const p = pacer({ duty: 0.5, maxPauseMs: 1000, sleep: async ms => { slept.push(ms); } });
  await p(40); await p(5000);
  assert.deepEqual(slept, [40, 1000]);
  const q = pacer({ duty: 0.25, sleep: async ms => { slept.push(ms); } });
  await q(10);
  assert.equal(slept.at(-1), 30, "a quarter busy: three times as long asleep");
});

test("pace: pmset's battery line, on battery and on AC", () => {
  assert.deepEqual(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)	24%; discharging; 2:10 remaining present: true"), { percent: 24, onBattery: true });
  assert.deepEqual(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)	88%; charging;"), { percent: 88, onBattery: false });
  assert.equal(parsePmset("Now drawing from 'AC Power'"), null, "a Mac without a battery");
});

test("pace: the gate pauses on a busy machine or a low battery, and asks the OS at most once a minute", async () => {
  let t = 0, asked = 0, load = 1, bat = { percent: 80, onBattery: true };
  const g = gate({ cores: 4, load: () => load, battery: async () => { asked++; return bat; }, now: () => t });
  assert.equal(await g.check(), null);
  bat = { percent: 20, onBattery: true };
  t += 30_000;
  assert.equal(await g.check(), null, "cached for a minute");
  t += 31_000;
  assert.equal(await g.check(), "on battery at 20%");
  load = 9;
  t += 61_000;
  assert.equal(await g.check(), "the machine is busy (load 9.0 on 4 cores)");
  assert.equal(asked, 2, "the battery is not asked about while the load already says wait");
  bat = { percent: 20, onBattery: false }; load = 1; t += 61_000;
  assert.equal(await g.check(), null, "charging is fine at any level");
});

test("pace: indexing the fixture corpus through the niced one-thread model process stays near half a core", async t => {
  const home = tempHome(t);
  const runtime = path.join(home, "embedder");
  assert.equal((await install(runtime, { npm: fakeNpm(home) })).why, undefined);
  const dir = path.join(home, "transcripts");
  writeTranscripts(dir);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const ix = new Indexer(db, {});
  await ix.run([dir]);
  // The fake model burns 40 ms of CPU a call: the work, without the weights.
  const prev = process.env.FAKE_EMBED_SPIN_MS;
  process.env.FAKE_EMBED_SPIN_MS = "40";
  t.after(() => { if (prev === undefined) delete process.env.FAKE_EMBED_SPIN_MS; else process.env.FAKE_EMBED_SPIN_MS = prev; });
  const r = await spawnEmbedder({ cacheDir: path.join(home, "models"), runtime, download: false });
  assert.ok(r.embedder, r.why);
  const e = /** @type {any} */ (r.embedder);
  t.after(() => e.close());
  const before = await e.usage();
  const t0 = Date.now();
  const v = await ix.vectorize(e, { pace: pacer({ duty: 0.5 }) });
  const wall = Date.now() - t0;
  const after = await e.usage();
  const cpuMs = (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000;
  const cores = cpuMs / wall;
  t.diagnostic(`embedded ${v.turns} turns: ${cpuMs.toFixed(0)} ms CPU in ${wall} ms wall = ${cores.toFixed(2)} cores, nice ${after.nice}`);
  assert.equal(v.turns, 16);
  assert.equal(after.nice, 19, "the model's process runs at the lowest priority");
  assert.ok(cores <= 0.65, `used ${cores.toFixed(2)} cores; the budget is about half of one`);
  // No floor on cores: at nice 19 on a busy machine the model gets less, which is the point.
  assert.ok(cpuMs > 50, `used ${cpuMs.toFixed(0)} ms of CPU; the fake did not run`);
});

test("progress: one line for status and doctor, from recall.status", async () => {
  const { progressLine } = await import("./progress.js");
  const base = { sessions: 5678, turns: 40000, indexing: false, progress: { sessions: null, paused: null }, vectors: { on: true, embedded: 40000, pending: 0, why: "on (Xenova/all-MiniLM-L6-v2)" } };
  assert.equal(progressLine(base), null, "nothing in progress, nothing said");
  assert.equal(progressLine({ ...base, indexing: true, progress: { sessions: { done: 1234, total: 5678 }, paused: null } }), "indexing 1,234 of 5,678 sessions, low priority");
  assert.equal(progressLine({ ...base, vectors: { on: true, embedded: 1000, pending: 39000 } }), "search by meaning: 1,000 of 40,000 turns, low priority; keyword search works now");
  assert.equal(progressLine({ ...base, progress: { paused: "on battery at 20%" }, vectors: { on: true, embedded: 1000, pending: 39000 } }),
    "search by meaning: 1,000 of 40,000 turns, paused: on battery at 20%; keyword search works now");
});
